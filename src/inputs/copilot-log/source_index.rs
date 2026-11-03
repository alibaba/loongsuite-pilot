//! Durable byte cursors, correlation facts and delivery ledger for Copilot.
use anyhow::{ensure, Context, Result};
use rusqlite::types::Value as SqlValue;
use rusqlite::{params, Connection, OptionalExtension, Params};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

const READ_BUDGET: u64 = 4 * 1024 * 1024;
const EVENT_TYPES: &[&str] = &[
    "session.start",
    "session.shutdown",
    "user.message",
    "system.message",
    "assistant.turn_start",
    "assistant.message",
    "assistant.turn_end",
    "tool.execution_start",
    "tool.execution_complete",
    "permission.completed",
    "abort",
];
type Row = Vec<SqlValue>;
fn rows<P: Params>(db: &Connection, sql: &str, params: P) -> Result<Vec<Row>> {
    let mut statement = db.prepare(sql)?;
    let count = statement.column_count();
    let result = statement
        .query_map(params, |row| {
            (0..count)
                .map(|index| row.get(index))
                .collect::<rusqlite::Result<Row>>()
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(result)
}
fn string(row: &Row, index: usize) -> &str {
    match row.get(index) {
        Some(SqlValue::Text(value)) => value,
        _ => "",
    }
}
fn integer(row: &Row, index: usize) -> i64 {
    match row.get(index) {
        Some(SqlValue::Integer(value)) => *value,
        _ => 0,
    }
}
fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}
fn event_stamp(text: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|stamp| stamp.timestamp_millis())
}
fn native_stamp(span: &Value) -> Option<i64> {
    let parts = span.get("startTime")?.as_array()?;
    if parts.len() != 2 {
        return None;
    }
    let seconds = parts[0].as_i64()?;
    let nanos = parts[1].as_i64()?;
    if seconds < 0 || !(0..1_000_000_000).contains(&nanos) {
        return None;
    }
    let ms = seconds.checked_mul(1000)?.checked_add(nanos / 1_000_000)?;
    chrono::DateTime::from_timestamp_millis(ms).map(|_| ms)
}
fn iso(ms: i64) -> Option<String> {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|stamp| stamp.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}
fn file_identity(file: &File, _metadata: &std::fs::Metadata) -> Result<String> {
    let identity = crate::utils::file_identity::identity_from_open(file)?;
    Ok(format!("{}:{}", identity.dev, identity.ino))
}

fn anchor(file: &mut File, end: u64) -> Result<String> {
    let count = end.min(64) as usize;
    let mut buffer = vec![0; count];
    file.seek(SeekFrom::Start(end - count as u64))?;
    let mut position = 0;
    while position < count {
        let read = file.read(&mut buffer[position..])?;
        if read == 0 {
            break;
        }
        position += read;
    }
    Ok(hex::encode(Sha256::digest(&buffer[..position])))
}
pub struct CopilotSourceIndex {
    db: Connection,
    collection_start: Option<i64>,
}
pub struct IndexedInteraction {
    pub session: String,
    pub id: String,
}
pub struct CorrelatedSource {
    pub events: Vec<Value>,
    pub spans: Vec<Value>,
}
impl CopilotSourceIndex {
    pub fn open(path: &Path) -> Result<Self> {
        let parent = path
            .parent()
            .context("Copilot index requires a parent directory")?;
        std::fs::create_dir_all(parent)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
        }
        let db = Connection::open(path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        }
        db.execute_batch(include_str!("source_index_schema.sql"))?;
        Ok(Self {
            db,
            collection_start: None,
        })
    }
    pub fn history_start_time(&self) -> Result<Option<i64>> {
        let values = rows(&self.db, "SELECT start_ms FROM collection_policy", [])?;
        ensure!(
            values.len() <= 1,
            "Invalid Copilot source-index collection policy"
        );
        values
            .first()
            .map(|row| {
                ensure!(
                    matches!(row.first(), Some(SqlValue::Integer(_))),
                    "Invalid Copilot history boundary type"
                );
                let start = integer(row, 0);
                ensure!(start >= 0, "Invalid Copilot history boundary");
                Ok(start)
            })
            .transpose()
    }
    pub fn apply_history_policy(&mut self, start: i64) -> Result<()> {
        ensure!(start >= 0, "Invalid Copilot history boundary");
        let previous = self.history_start_time()?;
        ensure!(
            previous.is_none_or(|previous| previous == start),
            "Copilot source-index history boundary changed"
        );
        self.collection_start = Some(start);
        if previous.is_none() {
            self.transaction(||{
                self.db.execute("INSERT INTO collection_policy VALUES(?)",[start])?;
                let mut cursor=0i64;
                loop{
                    let page=rows(&self.db,"SELECT rowid,session,id FROM interactions WHERE rowid>? ORDER BY rowid LIMIT 256",[cursor])?;
                    if page.is_empty(){break;}
                    for row in page{cursor=integer(&row,0);self.is_eligible(string(&row,1),string(&row,2))?;}
                }
                self.db.execute("DELETE FROM records AS r WHERE r.kind='span' AND r.interaction=''
                    AND NOT EXISTS(SELECT 1 FROM records c WHERE c.kind='span' AND c.session=r.session
                    AND c.trace=r.trace AND c.interaction<>'')",[])?;
                Ok(())
            })?;
        }
        // Existing records are evaluated through is_eligible before delivery;
        // legacy native bodies are reindexed once under the adopted policy.
        self.migrate_legacy_native_bodies()?;
        Ok(())
    }
    fn migrate_legacy_native_bodies(&self) -> Result<()> {
        let name = "legacy-native-bodies-v1";
        if self
            .db
            .query_row(
                "SELECT 1 FROM index_migrations WHERE name=?",
                [name],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .is_some()
        {
            return Ok(());
        }
        self.transaction(||{
            self.db.execute_batch("CREATE TEMP TABLE legacy_native_traces AS
                SELECT DISTINCT r.session,r.trace FROM records r JOIN ignored_interactions i
                  ON i.session=r.session AND i.id=r.interaction
                WHERE r.kind='span' AND i.reason LIKE 'native-%'
                  AND NOT EXISTS(SELECT 1 FROM records c JOIN records u
                    ON u.session=c.session AND u.interaction=c.interaction
                    WHERE c.kind='span' AND c.session=r.session AND c.trace=r.trace
                      AND u.kind='event' AND u.type='user.message');")?;
            let count=self.db.query_row("SELECT COUNT(*) FROM legacy_native_traces",[],|row|row.get::<_,i64>(0))?;
            if count>0{
                self.db.execute_batch("DELETE FROM records WHERE kind='span' AND EXISTS(
                    SELECT 1 FROM legacy_native_traces t WHERE t.session=records.session AND t.trace=records.trace);
                    DELETE FROM partial_chunks WHERE path IN (SELECT path FROM sources WHERE kind='span');
                    DELETE FROM partial_sources WHERE path IN (SELECT path FROM sources WHERE kind='span');
                    DELETE FROM deferred_spans WHERE path IN (SELECT path FROM sources WHERE kind='span');
                    UPDATE sources SET offset=0,anchor='',session='',active='' WHERE kind='span';
                    DELETE FROM interactions WHERE EXISTS(SELECT 1 FROM ignored_interactions i
                      WHERE i.session=interactions.session AND i.id=interactions.id AND i.reason LIKE 'native-%')
                      AND NOT EXISTS(SELECT 1 FROM records u WHERE u.kind='event' AND u.type='user.message'
                        AND u.session=interactions.session AND u.interaction=interactions.id);
                    DELETE FROM ignored_interactions WHERE reason LIKE 'native-%';")?;
            }
            self.db.execute_batch("DROP TABLE legacy_native_traces")?;
            self.db.execute("INSERT INTO index_migrations VALUES(?)",[name])?;
            Ok(())
        })
    }
    fn transaction<T>(&self, operation: impl FnOnce() -> Result<T>) -> Result<T> {
        self.db.execute_batch("BEGIN IMMEDIATE")?;
        match operation() {
            Ok(value) => {
                self.db.execute_batch("COMMIT")?;
                Ok(value)
            }
            Err(error) => {
                let _ = self.db.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }
    fn ignored(&self, session: &str, id: &str) -> Result<bool> {
        Ok(self
            .db
            .query_row(
                "SELECT 1 FROM ignored_interactions WHERE session=? AND id=?",
                params![session, id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .is_some())
    }
    fn ignore(&self, session: &str, id: &str, reason: &str, purge: bool) -> Result<()> {
        self.db.execute("INSERT INTO ignored_interactions VALUES(?,?,?) ON CONFLICT(session,id) DO UPDATE SET reason=excluded.reason
            WHERE ignored_interactions.reason LIKE 'native-%' AND excluded.reason NOT LIKE 'native-%'",params![session,id,reason])?;
        if purge {
            for sql in [
                "DELETE FROM records WHERE session=? AND interaction=?",
                "DELETE FROM interactions WHERE session=? AND id=?",
                "DELETE FROM native_wait WHERE session=? AND interaction=?",
                "DELETE FROM deferred_spans WHERE session=? AND interaction=?",
            ] {
                self.db.execute(sql, params![session, id])?;
            }
        }
        Ok(())
    }
    pub fn is_eligible(&self, session: &str, id: &str) -> Result<bool> {
        let Some(floor) = self.collection_start else {
            return Ok(true);
        };
        if self.ignored(session, id)? {
            return Ok(false);
        }
        let kind = if id.starts_with("summary:") {
            "session.shutdown"
        } else {
            "user.message"
        };
        let mut stamps=rows(&self.db,"SELECT stamp FROM records WHERE session=? AND interaction=? AND kind='event' AND type=? ORDER BY rowid LIMIT 1",params![session,id,kind])?;
        let native_only = stamps.is_empty() && kind != "session.shutdown";
        if native_only {
            stamps=rows(&self.db,"SELECT stamp FROM records WHERE session=? AND interaction=? AND kind='span' AND type='chat' ORDER BY rowid LIMIT 1",params![session,id])?;
        }
        let Some(row) = stamps.first() else {
            return Ok(false);
        };
        let stamp = event_stamp(string(row, 0));
        if stamp.is_none_or(|stamp| stamp < floor) {
            let reason = if stamp.is_some() {
                "before-activation"
            } else {
                "invalid-event-time"
            };
            self.ignore(
                session,
                id,
                &if native_only {
                    format!("native-{reason}")
                } else {
                    reason.into()
                },
                !native_only,
            )?;
            return Ok(false);
        }
        Ok(true)
    }
    pub fn ingest(&self, path: &Path, kind: &str) -> Result<()> {
        ensure!(
            matches!(kind, "event" | "span"),
            "Invalid Copilot source kind"
        );
        let mut file = File::open(path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Ok(());
        }
        let name = path.to_string_lossy();
        let identity = file_identity(&file, &metadata)?;
        let size = metadata.len();
        let previous = rows(
            &self.db,
            "SELECT identity,offset,session,active,anchor FROM sources WHERE path=?",
            [name.as_ref()],
        )?;
        let partial = rows(
            &self.db,
            "SELECT position,anchor FROM partial_sources WHERE path=?",
            [name.as_ref()],
        )?;
        let old = previous.first();
        let old_offset = old.map_or(0, |row| integer(row, 1).max(0) as u64);
        let reset = old.is_none()
            || old.is_some_and(|row| string(row, 0) != identity)
            || size < old_offset
            || old.is_some_and(|row| {
                string(row, 4) != anchor(&mut file, old_offset).unwrap_or_default()
            })
            || partial.first().is_some_and(|row| {
                size < integer(row, 0).max(0) as u64
                    || string(row, 1)
                        != anchor(&mut file, integer(row, 0).max(0) as u64).unwrap_or_default()
            });
        let mut offset = if reset { 0 } else { old_offset };
        let mut session = if reset {
            String::new()
        } else {
            old.map(|row| string(row, 2).to_owned()).unwrap_or_default()
        };
        let mut active = if reset {
            String::new()
        } else {
            old.map(|row| string(row, 3).to_owned()).unwrap_or_default()
        };
        let mut position = if reset {
            0
        } else {
            partial
                .first()
                .map_or(offset, |row| integer(row, 0).max(0) as u64)
        };
        if !reset && position == size {
            return Ok(());
        }
        let limit = size.min(position.saturating_add(READ_BUDGET));
        self.transaction(|| {
            if reset {
                for table in ["partial_chunks", "partial_sources", "deferred_spans"] {
                    self.db.execute(
                        &format!("DELETE FROM {table} WHERE path=?"),
                        [name.as_ref()],
                    )?;
                }
            }
            while position < limit {
                let mut chunk = vec![0; (limit - position).min(64 * 1024) as usize];
                file.seek(SeekFrom::Start(position))?;
                let read = file.read(&mut chunk)?;
                if read == 0 {
                    break;
                }
                chunk.truncate(read);
                let chunk_start = position;
                position += read as u64;
                let mut start = 0;
                for end in chunk
                    .iter()
                    .enumerate()
                    .filter_map(|(index, byte)| (*byte == b'\n').then_some(index))
                {
                    let mut line = Vec::new();
                    if offset < chunk_start + start as u64 {
                        let stored = rows(
                            &self.db,
                            "SELECT body FROM partial_chunks WHERE path=? ORDER BY position",
                            [name.as_ref()],
                        )?;
                        for row in stored {
                            if let Some(SqlValue::Blob(body)) = row.into_iter().next() {
                                line.extend(body);
                            }
                        }
                        self.db
                            .execute("DELETE FROM partial_chunks WHERE path=?", [name.as_ref()])?;
                    }
                    line.extend_from_slice(&chunk[start..=end]);
                    let raw = String::from_utf8_lossy(&line);
                    let record = serde_json::from_str::<Value>(raw.trim())
                        .ok()
                        .filter(Value::is_object);
                    match record {
                        Some(record) if kind == "event" => {
                            self.ingest_event(&record, raw.trim(), &mut session, &mut active)?
                        }
                        Some(record) => self.ingest_span(
                            &record,
                            raw.trim(),
                            &name,
                            &identity,
                            offset,
                            line.len() as u64,
                        )?,
                        None if !raw.trim().is_empty() => {
                            if kind == "event" {
                                active.clear();
                            }
                            crate::utils::create_logger("CopilotSourceIndex").warn(
                                "Skipping malformed complete Copilot record",
                                serde_json::json!({"file":name,"offset":offset}).as_object(),
                            );
                        }
                        None => {}
                    }
                    offset = chunk_start + end as u64 + 1;
                    start = end + 1;
                }
                if start < chunk.len() {
                    self.db.execute(
                        "INSERT OR REPLACE INTO partial_chunks VALUES(?,?,?)",
                        params![name.as_ref(), chunk_start + start as u64, &chunk[start..]],
                    )?;
                }
            }
            self.db.execute(
                "INSERT OR REPLACE INTO sources VALUES(?,?,?,?,?,?,?)",
                params![
                    name.as_ref(),
                    kind,
                    identity,
                    offset,
                    session,
                    active,
                    anchor(&mut file, offset)?
                ],
            )?;
            if position > offset {
                self.db.execute(
                    "INSERT OR REPLACE INTO partial_sources VALUES(?,?,?)",
                    params![name.as_ref(), position, anchor(&mut file, position)?],
                )?;
            } else {
                self.db
                    .execute("DELETE FROM partial_sources WHERE path=?", [name.as_ref()])?;
            }
            Ok(())
        })
    }
    fn ingest_event(
        &self,
        record: &Value,
        raw: &str,
        session: &mut String,
        active: &mut String,
    ) -> Result<()> {
        let kind = text(record, "type");
        let data = &record["data"];
        let id = text(record, "id");
        if kind == "session.start" {
            *session = text(data, "sessionId").into();
            active.clear();
        }
        if let Some(explicit) = data.get("interactionId").and_then(Value::as_str) {
            *active = explicit.into();
        } else if kind == "user.message" {
            *active = id.into();
        }
        if session.is_empty() || !EVENT_TYPES.contains(&kind) || id.is_empty() {
            return Ok(());
        }
        let interaction = if kind == "session.shutdown" {
            format!("summary:{id}")
        } else {
            active.clone()
        };
        let mut retain = true;
        if let Some(floor) = self.collection_start.filter(|_| !interaction.is_empty()) {
            if matches!(kind, "user.message" | "session.shutdown") {
                let stamp = event_stamp(text(record, "timestamp"));
                if stamp.is_none_or(|stamp| stamp < floor) {
                    self.ignore(
                        session.as_str(),
                        &interaction,
                        if stamp.is_some() {
                            "before-activation"
                        } else {
                            "invalid-event-time"
                        },
                        true,
                    )?;
                } else if kind == "user.message" {
                    self.db.execute(
                        "DELETE FROM ignored_interactions WHERE session=? AND id=?
                        AND reason IN ('native-before-activation','native-invalid-event-time')",
                        params![session.as_str(), interaction],
                    )?;
                }
            }
            retain = !self.ignored(session.as_str(), &interaction)?;
        }
        if retain && (!interaction.is_empty() || kind == "session.start") {
            self.db.execute(
                "INSERT OR IGNORE INTO records VALUES(?,?,?,?,?,?,?,?)",
                params![
                    "event",
                    session.as_str(),
                    id,
                    interaction,
                    kind,
                    "",
                    text(record, "timestamp"),
                    raw
                ],
            )?;
            if !interaction.is_empty() {
                self.db.execute(
                    "INSERT OR IGNORE INTO interactions(session,id) VALUES(?,?)",
                    params![session.as_str(), interaction],
                )?;
            }
        }
        Ok(())
    }
    fn ingest_span(
        &self,
        span: &Value,
        raw: &str,
        path: &str,
        identity: &str,
        offset: u64,
        bytes: u64,
    ) -> Result<()> {
        let attrs = &span["attributes"];
        let session = text(attrs, "gen_ai.conversation.id");
        let id = text(span, "spanId");
        if span["type"] != "span" || session.is_empty() || id.is_empty() {
            return Ok(());
        }
        let interaction = text(attrs, "github.copilot.interaction_id");
        let trace = text(span, "traceId");
        let stamp = native_stamp(span);
        let mut retain = true;
        if let Some(floor) = self.collection_start {
            let authoritative = if !interaction.is_empty() {
                let user=self.db.query_row("SELECT stamp FROM records WHERE kind='event' AND session=? AND interaction=?
                    AND type='user.message' ORDER BY rowid LIMIT 1",params![session,interaction],|row|row.get::<_,String>(0)).optional()?;
                user.as_deref()
                    .and_then(event_stamp)
                    .is_some_and(|stamp| stamp >= floor)
            } else {
                self.db.query_row("SELECT 1 FROM records c JOIN records u ON u.session=c.session AND u.interaction=c.interaction
                    WHERE c.kind='span' AND c.session=? AND c.trace=? AND c.interaction<>''
                    AND u.kind='event' AND u.type='user.message' LIMIT 1",params![session,trace],|row|row.get::<_,i64>(0)).optional()?.is_some()
            };
            retain = stamp.is_some_and(|stamp| authoritative || stamp >= floor)
                && (interaction.is_empty() || !self.ignored(session, interaction)?);
        }
        if retain {
            self.db.execute(
                "INSERT OR IGNORE INTO records VALUES(?,?,?,?,?,?,?,?)",
                params![
                    "span",
                    session,
                    id,
                    interaction,
                    text(attrs, "gen_ai.operation.name"),
                    trace,
                    stamp.and_then(iso).unwrap_or_default(),
                    raw
                ],
            )?;
            if !interaction.is_empty() {
                self.db.execute(
                    "INSERT OR IGNORE INTO interactions(session,id) VALUES(?,?)",
                    params![session, interaction],
                )?;
            }
        } else if stamp.is_some()
            && (interaction.is_empty() || !self.ignored(session, interaction)?)
        {
            self.db.execute("INSERT OR REPLACE INTO deferred_spans(session,id,interaction,trace,path,identity,offset,bytes)
                VALUES(?,?,?,?,?,?,?,?)",params![session,id,interaction,trace,path,identity,offset,bytes])?;
        }
        Ok(())
    }
    pub fn awaiting_native(
        &self,
        session: &str,
        interaction: &str,
        now: i64,
        grace: i64,
    ) -> Result<bool> {
        self.db.execute(
            "INSERT OR IGNORE INTO native_wait VALUES(?,?,?)",
            params![session, interaction, now],
        )?;
        let since = self.db.query_row(
            "SELECT since FROM native_wait WHERE session=? AND interaction=?",
            params![session, interaction],
            |row| row.get::<_, i64>(0),
        )?;
        Ok(now.saturating_sub(since) < grace)
    }
    pub fn has_unread_source(&self) -> Result<bool> {
        for row in rows(&self.db,"SELECT s.path,s.offset,p.position FROM sources s LEFT JOIN partial_sources p ON p.path=s.path",[])?{
            let read=if matches!(row.get(2),Some(SqlValue::Integer(_))){integer(&row,2)}else{integer(&row,1)};
            if std::fs::metadata(string(&row,0)).is_ok_and(|metadata|metadata.len()>read.max(0) as u64){return Ok(true);}
        }
        Ok(false)
    }
    pub fn pending(&self) -> Result<Vec<IndexedInteraction>> {
        let values=rows(&self.db,"SELECT i.session,i.id FROM interactions i
            WHERE NOT EXISTS(SELECT 1 FROM delivered d WHERE d.key='copilot:'||i.session||':'||i.id)
              AND NOT EXISTS(SELECT 1 FROM ignored_interactions h WHERE h.session=i.session AND h.id=i.id)
            ORDER BY checked,rowid LIMIT 8",[])?;
        self.db.execute_batch("UPDATE sequence SET value=value+1")?;
        let mut pending = Vec::new();
        for row in values {
            let session = string(&row, 0).to_owned();
            let id = string(&row, 1).to_owned();
            self.db.execute("UPDATE interactions SET checked=(SELECT value FROM sequence) WHERE session=? AND id=?",params![session,id])?;
            pending.push(IndexedInteraction { session, id });
        }
        Ok(pending)
    }
    fn json_rows<P: Params>(&self, sql: &str, params: P) -> Result<Vec<Value>> {
        rows(&self.db, sql, params)?
            .into_iter()
            .map(|row| serde_json::from_str(string(&row, 0)).map_err(Into::into))
            .collect()
    }
    pub fn load(&self, session: &str, interaction: &str) -> Result<CorrelatedSource> {
        let events = self.json_rows(
            "SELECT body FROM records WHERE kind='event' AND session=?
            AND (interaction=? OR type='session.start') ORDER BY stamp,rowid",
            params![session, interaction],
        )?;
        let chats = self.json_rows(
            "SELECT body FROM records WHERE kind='span' AND session=? AND interaction=?",
            params![session, interaction],
        )?;
        let traces: BTreeSet<_> = chats
            .iter()
            .map(|span| text(span, "traceId"))
            .filter(|trace| !trace.is_empty())
            .collect();
        let mut spans = Vec::new();
        for trace in traces {
            spans.extend(self.json_rows(
                "SELECT body FROM records WHERE kind='span' AND session=? AND trace=?",
                params![session, trace],
            )?);
        }
        Ok(CorrelatedSource { events, spans })
    }
    pub fn has_native(&self, session: &str) -> Result<bool> {
        Ok(self.db.query_row("SELECT 1 FROM records WHERE kind='span' AND session=?
            UNION ALL SELECT 1 FROM deferred_spans d JOIN records u ON u.session=d.session AND u.interaction=d.interaction
            WHERE d.session=? AND u.kind='event' AND u.type='user.message' LIMIT 1",params![session,session],
            |row|row.get::<_,i64>(0)).optional()?.is_some())
    }
    pub fn mark_delivered(&self, keys: &[String]) -> Result<()> {
        self.transaction(|| {
            for key in keys {
                self.db
                    .execute("INSERT OR IGNORE INTO delivered VALUES(?)", [key])?;
            }
            Ok(())
        })
    }
    pub fn prune_deleted_sessions(&self, files: &[PathBuf]) -> Result<()> {
        let sources = rows(
            &self.db,
            "SELECT path,session FROM sources WHERE kind='event'",
            [],
        )?;
        let live: HashSet<_> = files
            .iter()
            .map(|file| file.to_string_lossy().into_owned())
            .collect();
        for row in &sources {
            let path = string(row, 0);
            let session = string(row, 1);
            if live.contains(path)
                || session.is_empty()
                || sources
                    .iter()
                    .any(|other| string(other, 1) == session && live.contains(string(other, 0)))
            {
                continue;
            }
            self.transaction(|| {
                for table in [
                    "records",
                    "interactions",
                    "native_wait",
                    "ignored_interactions",
                    "deferred_spans",
                ] {
                    self.db
                        .execute(&format!("DELETE FROM {table} WHERE session=?"), [session])?;
                }
                let prefix = format!("copilot:{session}:");
                self.db.execute(
                    "DELETE FROM delivered WHERE substr(key,1,?)=?",
                    params![prefix.chars().count(), prefix],
                )?;
                for table in ["partial_chunks", "partial_sources", "sources"] {
                    self.db
                        .execute(&format!("DELETE FROM {table} WHERE path=?"), [path])?;
                }
                Ok(())
            })?;
        }
        Ok(())
    }
    pub fn restore_deferred_spans(&self) -> Result<()> {
        let traces=rows(&self.db,"SELECT session,trace FROM (SELECT d.session,d.trace,MIN(d.checked) AS checked FROM records u
            JOIN deferred_spans d ON d.session=u.session AND d.interaction=u.interaction
            WHERE u.kind='event' AND u.type='user.message' AND d.interaction<>''
            GROUP BY d.session,d.trace
            UNION SELECT d.session,d.trace,MIN(d.checked) AS checked FROM records u
            JOIN records c ON c.session=u.session AND c.interaction=u.interaction
            JOIN deferred_spans d ON d.session=c.session AND d.trace=c.trace
            WHERE u.kind='event' AND u.type='user.message' AND c.kind='span' AND c.interaction<>''
            GROUP BY d.session,d.trace) GROUP BY session,trace ORDER BY MIN(checked),session,trace LIMIT 8",[])?;
        let mut read_bytes = 0u64;
        let mut unavailable = HashSet::new();
        for trace_row in traces {
            let session = string(&trace_row, 0);
            let trace = string(&trace_row, 1);
            self.db.execute_batch("UPDATE sequence SET value=value+1")?;
            let locators = rows(
                &self.db,
                "SELECT id,interaction,path,identity,offset,bytes FROM deferred_spans
                WHERE session=? AND trace=? ORDER BY checked,path,offset LIMIT 256",
                params![session, trace],
            )?;
            for locator in locators {
                let id = string(&locator, 0);
                let interaction = string(&locator, 1);
                let path = string(&locator, 2);
                let expected_identity = string(&locator, 3);
                let offset = integer(&locator, 4);
                let bytes = integer(&locator, 5);
                let remove = || -> Result<()> {
                    self.db.execute(
                        "DELETE FROM deferred_spans WHERE session=? AND id=?",
                        params![session, id],
                    )?;
                    Ok(())
                };
                if offset < 0 || bytes <= 0 {
                    remove()?;
                    continue;
                }
                let bytes = bytes as u64;
                let offset = offset as u64;
                if read_bytes > 0 && read_bytes.saturating_add(bytes) > READ_BUDGET {
                    return Ok(());
                }
                if self
                    .db
                    .query_row(
                        "SELECT 1 FROM records WHERE kind='span' AND session=? AND id=?",
                        params![session, id],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()?
                    .is_some()
                {
                    remove()?;
                    continue;
                }
                self.db.execute("UPDATE deferred_spans SET checked=(SELECT value FROM sequence) WHERE session=? AND id=?",params![session,id])?;
                if unavailable.contains(path) {
                    continue;
                }
                let restored = (|| -> Result<Option<Value>> {
                    let mut file = File::open(path)?;
                    let metadata = file.metadata()?;
                    if file_identity(&file, &metadata)? != expected_identity
                        || metadata.len() < offset.saturating_add(bytes)
                    {
                        return Ok(None);
                    }
                    let size = usize::try_from(bytes)
                        .context("Copilot native source record is too large")?;
                    let mut buffer = Vec::new();
                    buffer.try_reserve_exact(size)?;
                    buffer.resize(size, 0);
                    file.seek(SeekFrom::Start(offset))?;
                    let mut position = 0;
                    while position < buffer.len() {
                        let read = file.read(&mut buffer[position..])?;
                        if read == 0 {
                            break;
                        }
                        position += read;
                    }
                    read_bytes += position as u64;
                    if position != size {
                        anyhow::bail!("Copilot deferred source changed while reading");
                    }
                    let span = serde_json::from_slice::<Value>(&buffer).ok();
                    Ok(span.filter(|span| {
                        span["type"] == "span"
                            && text(span, "spanId") == id
                            && text(span, "traceId") == trace
                            && text(&span["attributes"], "gen_ai.conversation.id") == session
                            && native_stamp(span).is_some()
                    }))
                })();
                match restored {
                    Ok(Some(span)) => {
                        let stamp = native_stamp(&span)
                            .and_then(iso)
                            .context("Invalid Copilot native timestamp")?;
                        self.db.execute(
                            "INSERT OR IGNORE INTO records VALUES(?,?,?,?,?,?,?,?)",
                            params![
                                "span",
                                session,
                                id,
                                interaction,
                                text(&span["attributes"], "gen_ai.operation.name"),
                                trace,
                                stamp,
                                span.to_string()
                            ],
                        )?;
                        if !interaction.is_empty() {
                            self.db.execute(
                                "INSERT OR IGNORE INTO interactions(session,id) VALUES(?,?)",
                                params![session, interaction],
                            )?;
                        }
                        remove()?;
                    }
                    Ok(None) => {
                        remove()?;
                    }
                    Err(_) => {
                        unavailable.insert(path.to_owned());
                        crate::utils::create_logger("CopilotSourceIndex").warn(
                            "Copilot deferred native source unavailable; retaining locator",
                            None,
                        );
                    }
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;
    fn fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../../tests/fixtures/copilot/conversation.json"
        ))
        .unwrap()
    }
    fn lines(values: &[Value]) -> String {
        values
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
            + "\n"
    }
    #[test]
    fn malformed_complete_records_recover_at_explicit_boundary_and_delivery_survives_restart() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("events.jsonl");
        let path = root.path().join("index.sqlite");
        let fixture = fixture();
        let events = fixture["events"].as_array().unwrap();
        std::fs::write(
            &file,
            lines(&events[..1]) + "{broken\nnull\n" + &lines(&events[1..]),
        )
        .unwrap();
        let index = CopilotSourceIndex::open(&path).unwrap();
        index.ingest(&file, "event").unwrap();
        let pending = index.pending().unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(
            index
                .load("session-test", "interaction-a")
                .unwrap()
                .events
                .len(),
            events.len()
        );
        index
            .mark_delivered(&["copilot:session-test:interaction-a".into()])
            .unwrap();
        drop(index);
        let restored = CopilotSourceIndex::open(&path).unwrap();
        restored.ingest(&file, "event").unwrap();
        assert!(restored.pending().unwrap().is_empty());
    }
    #[test]
    fn multi_budget_partial_line_resumes_after_restart_and_copy_truncate_discards_fragments() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("events.jsonl");
        let path = root.path().join("index.sqlite");
        let fixture = fixture();
        let event = &fixture["events"][0];
        let mut user = fixture["events"][1].clone();
        user["data"]["content"] = json!("x".repeat(10 * 1024 * 1024));
        let prefix = lines(std::slice::from_ref(event));
        std::fs::write(&file, prefix.clone() + &user.to_string()).unwrap();
        let index = CopilotSourceIndex::open(&path).unwrap();
        index.ingest(&file, "event").unwrap();
        assert_eq!(
            integer(
                &rows(&index.db, "SELECT position FROM partial_sources", []).unwrap()[0],
                0
            ),
            READ_BUDGET as i64
        );
        drop(index);
        let index = CopilotSourceIndex::open(&path).unwrap();
        index.ingest(&file, "event").unwrap();
        index.ingest(&file, "event").unwrap();
        let before = rows(&index.db, "SELECT COUNT(*) FROM partial_chunks", []).unwrap();
        index.ingest(&file, "event").unwrap();
        assert_eq!(
            before,
            rows(&index.db, "SELECT COUNT(*) FROM partial_chunks", []).unwrap()
        );
        std::fs::OpenOptions::new()
            .append(true)
            .open(&file)
            .unwrap()
            .write_all(b"\n")
            .unwrap();
        index.ingest(&file, "event").unwrap();
        assert_eq!(
            index
                .load("session-test", "interaction-a")
                .unwrap()
                .events
                .last()
                .unwrap()["data"]["content"]
                .as_str()
                .unwrap()
                .len(),
            10 * 1024 * 1024
        );
        assert_eq!(
            integer(
                &rows(&index.db, "SELECT COUNT(*) FROM partial_chunks", []).unwrap()[0],
                0
            ),
            0
        );
        std::fs::write(&file, lines(fixture["events"].as_array().unwrap())).unwrap();
        index.ingest(&file, "event").unwrap();
        assert!(!index.pending().unwrap().is_empty());
    }
    #[test]
    fn authoritative_user_boundary_restores_skewed_native_locators_without_persisting_history_body()
    {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("index.sqlite");
        let events_file = root.path().join("events.jsonl");
        let spans_file = root.path().join("native.jsonl");
        let fixture = fixture();
        let mut events = fixture["events"].as_array().unwrap().clone();
        let spans = fixture["spans"].as_array().unwrap();
        let floor = event_stamp("2026-09-01T00:00:10Z").unwrap();
        let mut index = CopilotSourceIndex::open(&path).unwrap();
        index.apply_history_policy(floor).unwrap();
        std::fs::write(&spans_file, lines(spans)).unwrap();
        index.ingest(&spans_file, "span").unwrap();
        assert_eq!(
            integer(
                &rows(
                    &index.db,
                    "SELECT COUNT(*) FROM records WHERE kind='span'",
                    []
                )
                .unwrap()[0],
                0
            ),
            0
        );
        assert!(
            integer(
                &rows(&index.db, "SELECT COUNT(*) FROM deferred_spans", []).unwrap()[0],
                0
            ) > 0
        );
        for event in &mut events {
            event["timestamp"] = json!("2026-09-01T00:00:20Z");
        }
        std::fs::write(&events_file, lines(&events)).unwrap();
        index.ingest(&events_file, "event").unwrap();
        index.restore_deferred_spans().unwrap();
        assert_eq!(
            index
                .load("session-test", "interaction-a")
                .unwrap()
                .spans
                .len(),
            spans.len()
        );
        assert!(index.is_eligible("session-test", "interaction-a").unwrap());
        assert!(index.apply_history_policy(floor + 1).is_err());
    }
    #[test]
    fn database_failure_rolls_back_records_and_cursor_and_allows_retry() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("index.sqlite");
        let file = root.path().join("events.jsonl");
        let index = CopilotSourceIndex::open(&path).unwrap();
        std::fs::write(&file, lines(fixture()["events"].as_array().unwrap())).unwrap();
        index.db.execute_batch("CREATE TRIGGER fail_cursor BEFORE INSERT ON sources BEGIN SELECT RAISE(FAIL,'injected source failure'); END;").unwrap();
        assert!(index.ingest(&file, "event").is_err());
        assert_eq!(
            integer(
                &rows(&index.db, "SELECT COUNT(*) FROM records", []).unwrap()[0],
                0
            ),
            0
        );
        assert_eq!(
            integer(
                &rows(&index.db, "SELECT COUNT(*) FROM sources", []).unwrap()[0],
                0
            ),
            0
        );
        index.db.execute_batch("DROP TRIGGER fail_cursor").unwrap();
        index.ingest(&file, "event").unwrap();
        assert_eq!(index.pending().unwrap().len(), 1);
    }
}

#[cfg(test)]
#[path = "source_index_history_contract_tests.rs"]
mod source_index_history_contract_tests;
