//! One durable transaction contains both a source checkpoint and its events.
//! The JSON checkpoint remains compatible; SQLite is authoritative after a crash.
use super::abi::{OnBatch, PilotJsonView, ACK};
use super::policy::Delivery;
use crate::checkpoints::StateStore;
use crate::flushers::{BaseFlusher, FlushError, QuotaAlarm};
use crate::types::{AgentActivityEntry, AgentEventName};
use async_trait::async_trait;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::time::{Duration, Instant};

const CODEX_SHELL_MIGRATED: &str = "__pilot_codex_shell_migrated_v1";
const CODEX_LEGACY_EXPORTED: &str = "__pilot_codex_legacy_exported_v1";
const QODER_LEGACY_EXPORTED: &str = "__pilot_qoder_legacy_exported_v1";
const HOOK_HISTORY_LEGACY_EXPORTED: &str = "__pilot_hook_history_legacy_exported_v1";

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum LegacyCheckpointHandoff {
    Codex,
    Qoder,
    HookHistory(&'static str),
}

impl LegacyCheckpointHandoff {
    fn marker(self) -> &'static str {
        match self {
            Self::Codex => CODEX_LEGACY_EXPORTED,
            Self::Qoder => QODER_LEGACY_EXPORTED,
            Self::HookHistory(_) => HOOK_HISTORY_LEGACY_EXPORTED,
        }
    }

    pub(crate) fn for_input(input: &str) -> Option<Self> {
        match input {
            "codex-transcript" | "codex-aborted-turn" => Some(Self::Codex),
            "qoder-trace" => Some(Self::Qoder),
            "openclaw-plugin-log" => Some(Self::HookHistory("openclaw")),
            "opencode-log" => Some(Self::HookHistory("opencode")),
            "cursor-hook" => Some(Self::HookHistory("cursor")),
            "qwen-work-cn-trace" => Some(Self::HookHistory("qwen-work-cn")),
            "qwen-work-cn-collaboration" => Some(Self::HookHistory("qwen-work-cn-collaboration")),
            _ => None,
        }
    }

    pub(super) fn data_dir(self, pilot_dir: &Path, input: &str) -> PathBuf {
        let suffix = match self {
            Self::Qoder => return pilot_dir.join(super::STANDALONE_QODER_DATA),
            Self::Codex => input,
            Self::HookHistory(agent) => agent,
        };
        pilot_dir
            .join("state")
            .join(format!("standalone-{suffix}-sdk"))
    }
}

type DeliveryRows = Vec<(i64, Vec<u8>)>;

const SAVE_CHECKPOINT: &str = "INSERT INTO checkpoint VALUES(?1,?2)
    ON CONFLICT(source) DO UPDATE SET json=excluded.json WHERE checkpoint.json<>excluded.json";

type UsageUpdates = std::collections::BTreeMap<(String, String), [i64; 6]>;

fn record_usage(totals: &mut UsageUpdates, row: &AgentActivityEntry) {
    if row.event_name != Some(AgentEventName::LlmResponse) || row.agent_type.is_empty() {
        return;
    }
    let Some(day) = row
        .time_unix_nano
        .parse::<i64>()
        .ok()
        .filter(|n| *n > 0)
        .and_then(|n| chrono::DateTime::from_timestamp(n / 1_000_000_000, 0))
    else {
        return;
    };
    let value = totals
        .entry((row.agent_type.clone(), day.format("%Y-%m-%d").to_string()))
        .or_insert([0i64; 6]);
    let delta = [
        1,
        i64::from(row.input_tokens.is_some() || row.output_tokens.is_some()),
        row.input_tokens.unwrap_or(0),
        row.output_tokens.unwrap_or(0),
        row.cache_read_input_tokens.unwrap_or(0),
        row.cache_creation_input_tokens.unwrap_or(0),
    ];
    for (sum, v) in value.iter_mut().zip(delta) {
        *sum = sum.saturating_add(v.max(0));
    }
}

fn usage_updates(rows: &[AgentActivityEntry]) -> UsageUpdates {
    let mut totals = UsageUpdates::new();
    for row in rows {
        record_usage(&mut totals, row);
    }
    totals
}

fn prepare_owned_rows(
    entries: Vec<AgentActivityEntry>,
) -> Result<(Vec<Vec<u8>>, UsageUpdates), serde_json::Error> {
    let mut usage = UsageUpdates::new();
    // Keep the encoded batch atomic while releasing each original row's heap
    // allocations as soon as we have its usage and serialized payload.
    let encoded = entries
        .into_iter()
        .map(|entry| {
            record_usage(&mut usage, &entry);
            serde_json::to_vec(&entry)
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok((encoded, usage))
}

pub struct Outbox {
    db: Mutex<Connection>,
    pub verdicts: Arc<crate::interceptor::ToolVerdictStore>,
    pub options: RwLock<Delivery>,
    signal: (Mutex<bool>, Condvar),
    pub capacity_changed: tokio::sync::Notify,
    pub stopping: AtomicBool,
    pub accepted_events: AtomicU64,
    pub accepted_bytes: AtomicU64,
    pub acked_events: AtomicU64,
    pub acked_bytes: AtomicU64,
    pub retries: AtomicU64,
    pub callbacks: AtomicU64,
    pub last_error: Mutex<Option<String>>,
    pub identity: RwLock<Value>,
    pub local_hook_stats: Mutex<crate::interceptor::status::HookActivity>,
    pub local_hook_config: Mutex<Option<usize>>,
    pub hook_timings: Mutex<Vec<crate::metrics::HookTimingStats>>,
    pub callback_duration_us: AtomicU64,
    pub total_delay_ms: AtomicU64,
    pub last_ack_ms: AtomicU64,
    pub start_time: String,
    pub path: PathBuf,
    last_disk_compaction: Mutex<Instant>,
}

impl Outbox {
    pub fn open(root: &Path, options: Delivery) -> anyhow::Result<Arc<Self>> {
        crate::utils::source_access::private_path(root)?;
        std::fs::create_dir_all(root)?;
        let path = Self::database_path(root)?;
        let db = Connection::open_with_flags(
            &path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
                | rusqlite::OpenFlags::SQLITE_OPEN_CREATE
                | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX
                | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        db.busy_timeout(Duration::from_secs(1))?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            PRAGMA auto_vacuum=INCREMENTAL;
            CREATE TABLE IF NOT EXISTS checkpoint(source TEXT PRIMARY KEY, json TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS event(seq INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL,
                batch TEXT NOT NULL, payload BLOB NOT NULL, created INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS alarm(kind TEXT PRIMARY KEY, json TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS token_usage(agent TEXT,day TEXT,responses INTEGER,with_usage INTEGER,input INTEGER,output INTEGER,cache_read INTEGER,cache_creation INTEGER,PRIMARY KEY(agent,day));
            CREATE TABLE IF NOT EXISTS monitoring_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            INSERT OR IGNORE INTO monitoring_meta VALUES('usage_since',CAST(strftime('%s','now') AS TEXT));
            CREATE TABLE IF NOT EXISTS queue_size(singleton INTEGER PRIMARY KEY CHECK(singleton=1), bytes INTEGER NOT NULL, events INTEGER NOT NULL);
            INSERT OR IGNORE INTO queue_size SELECT 1,COALESCE(SUM(length(payload)),0),count(*) FROM event;
            BEGIN IMMEDIATE;
            DROP TRIGGER IF EXISTS event_accepted;
            DROP TRIGGER IF EXISTS event_acked;
            COMMIT;")?;
        let verdict_path = root.join("tool-verdicts.json");
        crate::utils::source_access::private_path(&verdict_path)?;
        let verdicts = Arc::new(crate::interceptor::ToolVerdictStore::new(verdict_path));
        verdicts.restore(chrono::Utc::now().timestamp_millis());
        Ok(Arc::new(Self {
            verdicts,
            db: Mutex::new(db),
            options: RwLock::new(options),
            signal: (Mutex::new(false), Condvar::new()),
            capacity_changed: tokio::sync::Notify::new(),
            stopping: AtomicBool::new(false),
            accepted_events: AtomicU64::new(0),
            accepted_bytes: AtomicU64::new(0),
            acked_events: AtomicU64::new(0),
            acked_bytes: AtomicU64::new(0),
            retries: AtomicU64::new(0),
            callbacks: AtomicU64::new(0),
            last_error: Mutex::new(None),
            identity: RwLock::new(json!({"user_id":"","ip":"","ver":env!("CARGO_PKG_VERSION")})),
            hook_timings: Mutex::new(Vec::new()),
            callback_duration_us: AtomicU64::new(0),
            total_delay_ms: AtomicU64::new(0),
            last_ack_ms: AtomicU64::new(0),
            local_hook_stats: Default::default(),
            local_hook_config: Default::default(),
            start_time: chrono::Utc::now().to_rfc3339(),
            last_disk_compaction: Mutex::new(Instant::now()),
            path,
        }))
    }
    pub fn enqueue_hook(&self, bytes: &[u8]) -> anyhow::Result<()> {
        let options = self.options.read().unwrap().clone();
        anyhow::ensure!(
            bytes.len() <= options.max_event_bytes,
            "hook record exceeds configured event size"
        );
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction()?;
        let used: usize =
            tx.query_row("SELECT bytes FROM queue_size WHERE singleton=1", [], |r| {
                r.get::<_, i64>(0)
            })? as usize;
        anyhow::ensure!(
            used.saturating_add(bytes.len()) <= options.queue_disk_bytes,
            "hook record queue is full; verdict was already returned"
        );
        tx.execute(
            "INSERT INTO event(source,batch,payload,created) VALUES('hook',?1,?2,?3)",
            params![
                uuid::Uuid::new_v4().to_string(),
                bytes,
                chrono::Utc::now().timestamp_millis()
            ],
        )?;
        Self::update_queue_size(&tx, bytes.len() as i64, 1)?;
        tx.commit()?;
        self.accepted_events.fetch_add(1, Ordering::SeqCst);
        self.accepted_bytes
            .fetch_add(bytes.len() as u64, Ordering::SeqCst);
        self.wake();
        Ok(())
    }

    pub fn alarm(&self, kind: &str, message: &str) {
        *self.last_error.lock().unwrap() = Some(message.to_owned());
        let message: String = message.chars().take(1024).collect();
        let value = json!({"event.name":"pilot.alarm","alarm_type":kind,"alarm_message":message,"time_unix_nano":chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0).to_string()});
        let mut value = self.decorate_alarm(value);
        let db = self.db.lock().unwrap();
        let previous = db
            .query_row("SELECT json FROM alarm WHERE kind=?1", [kind], |r| {
                r.get::<_, String>(0)
            })
            .ok();
        let count = previous
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|v| {
                v["alarm_count"]
                    .as_str()
                    .and_then(|s| s.parse::<u64>().ok())
            })
            .unwrap_or(0);
        value["alarm_count"] = json!(count.saturating_add(1).to_string());
        let _ = db.execute(
            "INSERT INTO alarm VALUES(?1,?2) ON CONFLICT(kind) DO UPDATE SET json=excluded.json",
            params![kind, value.to_string()],
        );
    }
    pub fn decorate_alarm(&self, mut row: Value) -> Value {
        let identity = self.identity.read().unwrap();
        for key in ["user_id", "ip", "ver"] {
            row[key] = identity[key].clone();
        }
        row["version"] = json!(env!("CARGO_PKG_VERSION"));
        row["event.name"] = json!("pilot.alarm");
        row["metrics_scope"] = json!(if matches!(
            row["alarm_type"].as_str(),
            Some("PROCESS_CPU_ALARM" | "PROCESS_MEMORY_ALARM")
        ) {
            "host_process"
        } else {
            "sdk_instance"
        });
        if row.get("alarm_level").is_none() {
            row["alarm_level"] = json!("2");
        }
        if row.get("alarm_count").is_none() {
            row["alarm_count"] = json!("1");
        }
        if row.get("__time__").is_none() {
            let seconds = row["time_unix_nano"]
                .as_str()
                .and_then(|s| s.parse::<i64>().ok())
                .map(|t| t / 1_000_000_000)
                .unwrap_or_else(|| chrono::Utc::now().timestamp());
            row["__time__"] = json!(seconds);
        }
        row
    }
    pub fn retain_alarm(&self, mut row: Value) {
        row = self.decorate_alarm(row);
        if let Some(kind) = row["alarm_type"].as_str().map(str::to_owned) {
            let db = self.db.lock().unwrap();
            let previous = db
                .query_row("SELECT json FROM alarm WHERE kind=?1", [&kind], |r| {
                    r.get::<_, String>(0)
                })
                .ok()
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                .and_then(|v| {
                    v["alarm_count"]
                        .as_str()
                        .and_then(|s| s.parse::<u64>().ok())
                })
                .unwrap_or(0);
            let count = row["alarm_count"]
                .as_str()
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(1);
            row["alarm_count"] = json!(count.saturating_add(previous).to_string());
            let _ = db.execute("INSERT INTO alarm VALUES(?1,?2) ON CONFLICT(kind) DO UPDATE SET json=excluded.json",params![kind,row.to_string()]);
        }
    }
    pub fn record_hook(&self, agent: &str, event: &str, duration_ms: f64) {
        let mut rows = self.hook_timings.lock().unwrap();
        if let Some(row) = rows
            .iter_mut()
            .find(|r| r.agent == agent && r.hook_event == event)
        {
            row.calls = row.calls.saturating_add(1);
            row.total_duration_ms += duration_ms;
            row.max_duration_ms = row.max_duration_ms.max(duration_ms);
        } else if rows.len() < 128 {
            rows.push(crate::metrics::HookTimingStats {
                agent: agent.into(),
                hook_event: event.into(),
                calls: 1,
                total_duration_ms: duration_ms,
                max_duration_ms: duration_ms,
            });
        }
    }
    pub fn token_rows(&self) -> Vec<Value> {
        let db = self.db.lock().unwrap();
        let since = db
            .query_row(
                "SELECT value FROM monitoring_meta WHERE key='usage_since'",
                [],
                |r| r.get::<_, String>(0),
            )
            .unwrap_or_default();
        let Ok(mut stmt)=db.prepare("SELECT agent,day,responses,with_usage,input,output,cache_read,cache_creation FROM token_usage ORDER BY day DESC,agent LIMIT 128")else{return Vec::new()};
        stmt.query_map([],|r|Ok(json!({"event.name":"pilot.token_usage","category":"sdk_tokens","agent":r.get::<_,String>(0)?,"date":r.get::<_,String>(1)?,
            "llm_responses_total":r.get::<_,i64>(2)?,"responses_with_usage":r.get::<_,i64>(3)?,"input_tokens_total":r.get::<_,i64>(4)?,"output_tokens_total":r.get::<_,i64>(5)?,
            "cache_read_tokens_total":r.get::<_,i64>(6)?,"cache_creation_tokens_total":r.get::<_,i64>(7)?,"usage_basis":"accepted_normalized_llm_response","source_scan_performed":false,"date_basis":"UTC","since_unix":since,"__time__":chrono::Utc::now().timestamp()})))
            .map(|rows|rows.filter_map(Result::ok).collect()).unwrap_or_default()
    }
    pub fn trace_rows(&self) -> Vec<Value> {
        let db = self.db.lock().unwrap();
        let mut row = json!({"event.name":"pilot.trace_runtime","schema_version":2,"record_type":"snapshot","buffer_scope":"sdk_delivery_outbox","agent_type":"sdk","converter_available":false,"converter_unavailable_reason":"activity_callback_does_not_run_otlp_conversion"});
        match db.query_row(
            "SELECT events,bytes FROM queue_size WHERE singleton=1",
            [],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
        ) {
            Ok((events, bytes)) => {
                row["collection_status"] = json!("ok");
                row["pending_buffers"] = json!(i64::from(events > 0));
                row["pending_records"] = json!(events);
                row["pending_logical_bytes"] = json!(bytes);
                row["largest_buffer_records"] = json!(events);
                row["largest_buffer_logical_bytes"] = json!(bytes);
                if events == 0 {
                    row["oldest_buffer_age_ms"] = json!(0);
                } else if let Ok(created) =
                    db.query_row("SELECT created FROM event ORDER BY seq LIMIT 1", [], |r| {
                        r.get::<_, i64>(0)
                    })
                {
                    row["oldest_buffer_age_ms"] = json!(chrono::Utc::now()
                        .timestamp_millis()
                        .saturating_sub(created)
                        .max(0));
                }
            }
            Err(_) => {
                row["collection_status"] = json!("unavailable");
            }
        }
        vec![row]
    }
    pub fn pending_bytes(&self) -> anyhow::Result<usize> {
        Ok(self.db.lock().unwrap().query_row(
            "SELECT bytes FROM queue_size WHERE singleton=1",
            [],
            |row| row.get::<_, i64>(0),
        )? as usize)
    }
    pub fn snapshot(&self) -> Value {
        let disk_bytes = [
            self.path.clone(),
            PathBuf::from(format!("{}-wal", self.path.display())),
            PathBuf::from(format!("{}-shm", self.path.display())),
        ]
        .iter()
        .filter_map(|p| std::fs::symlink_metadata(p).ok())
        .filter(|m| m.is_file())
        .map(|m| m.len())
        .sum::<u64>();
        let db = self.db.lock().unwrap();
        let (events, bytes): (i64, i64) = db
            .query_row(
                "SELECT events,bytes FROM queue_size WHERE singleton=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap_or_default();
        json!({"disk_bytes":disk_bytes,"pending_events":events,"pending_bytes":bytes,"retry_count":self.retries.load(Ordering::SeqCst),"callbacks_inflight":self.callbacks.load(Ordering::SeqCst),"callback_duration_ms_total":self.callback_duration_us.load(Ordering::SeqCst) as f64/1000.0,"last_ack_unix_ms":self.last_ack_ms.load(Ordering::SeqCst),"last_error":self.last_error.lock().unwrap().clone()})
    }
    pub fn update(&self, options: Delivery) {
        *self.options.write().unwrap() = options;
        self.wake();
        self.capacity_changed.notify_waiters();
    }
    pub fn wake(&self) {
        *self.signal.0.lock().unwrap() = true;
        self.signal.1.notify_all();
    }
    fn wait(&self, duration: Duration) {
        let signaled = self.signal.0.lock().unwrap();
        let (mut signaled, _) = self
            .signal
            .1
            .wait_timeout_while(signaled, duration, |flag| {
                !*flag && !self.stopping.load(Ordering::SeqCst)
            })
            .unwrap();
        *signaled = false;
    }
    pub async fn before_collect(&self, cancelled: &AtomicBool) -> anyhow::Result<()> {
        let mut pressured = false;
        loop {
            let notified = self.capacity_changed.notified();
            anyhow::ensure!(
                !cancelled.load(Ordering::SeqCst),
                "source stopped before collecting"
            );
            let options = self.options.read().unwrap().clone();
            let bytes = self.pending_bytes()?;
            let percent = if pressured {
                options.backpressure_low_percent
            } else {
                options.backpressure_high_percent
            };
            if bytes == 0
                || bytes.saturating_mul(100) < options.queue_disk_bytes.saturating_mul(percent)
            {
                return Ok(());
            }
            pressured = true;
            tokio::select! {_=notified=>{},_=tokio::time::sleep(Duration::from_millis(100))=>{}}
        }
    }
    fn database_path(root: &Path) -> anyhow::Result<PathBuf> {
        for suffix in ["", "-wal", "-shm"] {
            crate::utils::source_access::private_path(
                &root.join(format!("delivery.sqlite{suffix}")),
            )?;
        }
        Ok(root.join("delivery.sqlite"))
    }

    fn find_checkpoint(db: &Connection, source: &str) -> anyhow::Result<Option<String>> {
        use rusqlite::OptionalExtension;
        Ok(db
            .prepare_cached("SELECT json FROM checkpoint WHERE source=?1")?
            .query_row([source], |row| row.get(0))
            .optional()?)
    }

    fn open_checkpoint_database(root: &Path) -> anyhow::Result<Connection> {
        let db = Connection::open_with_flags(
            Self::database_path(root)?,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX
                | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        db.busy_timeout(Duration::from_secs(1))?;
        Ok(db)
    }

    pub(crate) fn read_persisted_checkpoint(
        root: &Path,
        source: &str,
    ) -> anyhow::Result<Option<String>> {
        Self::find_checkpoint(&Self::open_checkpoint_database(root)?, source)
    }

    pub(crate) fn read_acknowledged_checkpoint(
        root: &Path,
        source: &str,
    ) -> anyhow::Result<Option<String>> {
        use rusqlite::OptionalExtension;
        let db = Self::open_checkpoint_database(root)?;
        // The source checkpoint and queue depth must agree in the same snapshot.
        // Fail closed while even one event from this SDK instance awaits ACK.
        let checkpoint = db
            .query_row(
                "SELECT checkpoint.json FROM checkpoint, queue_size
                 WHERE source=?1 AND singleton=1 AND events=0",
                [source],
                |row| row.get(0),
            )
            .optional()?;
        Ok(checkpoint)
    }

    pub fn restore(&self, source: &str, path: &Path) -> anyhow::Result<()> {
        let checkpoint = Self::find_checkpoint(&self.db.lock().unwrap(), source)?;
        crate::utils::source_access::private_path(path)?;
        if let Some(text) = checkpoint {
            write_checkpoint(path, &text)?;
        }
        Ok(())
    }
    #[cfg(test)]
    fn saved_checkpoints(&self) -> anyhow::Result<Vec<(String, String)>> {
        let db = self.db.lock().unwrap();
        let mut statement = db.prepare("SELECT source,json FROM checkpoint")?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// The old shell marks its journal after taking ownership. Once a clean
    /// export completes, the legacy installation may also advance the cursor.
    /// Otherwise SQLite remains authoritative, including historically pending
    /// bytes from the first version of the Codex SDK.
    pub(super) fn prepare_shell_checkpoint(
        &self,
        source: &str,
        handoff: LegacyCheckpointHandoff,
        read_shell_checkpoint: impl FnOnce() -> anyhow::Result<Option<String>>,
    ) -> anyhow::Result<Option<String>> {
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction()?;
        let handed_off = Self::find_checkpoint(&tx, handoff.marker())?.is_some()
            || (handoff == LegacyCheckpointHandoff::Codex
                && Self::find_checkpoint(&tx, CODEX_SHELL_MIGRATED)?.is_some());
        if handed_off {
            let pending: i64 =
                tx.query_row("SELECT events FROM queue_size", [], |row| row.get(0))?;
            anyhow::ensure!(
                pending == 0,
                "checkpoint handoff retains unacknowledged activity"
            );
            let checkpoint = read_shell_checkpoint()?;
            let checkpoint = if handoff != LegacyCheckpointHandoff::Codex {
                // A missing legacy namespace cannot advance an existing cursor.
                let checkpoint = match checkpoint {
                    Some(text) => Some(text),
                    None => Self::find_checkpoint(&tx, source)?,
                };
                tx.execute("DELETE FROM checkpoint WHERE source=?1", [handoff.marker()])?;
                checkpoint
            } else {
                tx.execute("DELETE FROM checkpoint", [])?;
                checkpoint
            };
            if let Some(text) = checkpoint.as_deref() {
                tx.execute(SAVE_CHECKPOINT, params![source, text])?;
            }
            tx.commit()?;
            return Ok(checkpoint);
        }
        if handoff != LegacyCheckpointHandoff::Codex {
            return Self::find_checkpoint(&tx, source);
        }
        let mut checkpoints = {
            let mut statement = tx.prepare("SELECT json FROM checkpoint WHERE source<>?1")?;
            let rows = statement.query_map([source], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        if let Some(current) = Self::find_checkpoint(&tx, source)? {
            checkpoints.push(current);
        }
        if checkpoints.is_empty() {
            return Ok(None);
        }
        let mut merged = serde_json::Map::new();
        for checkpoint in checkpoints {
            for (key, value) in serde_json::from_str::<serde_json::Map<String, Value>>(&checkpoint)?
            {
                if let Some(previous) = merged.insert(key, value.clone()) {
                    anyhow::ensure!(
                        previous == value,
                        "conflicting Codex SDK source checkpoints"
                    );
                }
            }
        }
        let text = Value::Object(merged).to_string();
        tx.execute("DELETE FROM checkpoint WHERE source<>?1", [source])?;
        tx.execute(SAVE_CHECKPOINT, params![source, text])?;
        tx.commit()?;
        Ok(Some(text))
    }

    pub(crate) fn mark_shell_checkpoint_exported(
        root: &Path,
        handoff: LegacyCheckpointHandoff,
    ) -> anyhow::Result<()> {
        let mut db = Connection::open_with_flags(
            Self::database_path(root)?,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        db.busy_timeout(Duration::from_secs(1))?;
        let tx = db.transaction()?;
        let pending: i64 = tx.query_row("SELECT events FROM queue_size", [], |row| row.get(0))?;
        anyhow::ensure!(pending == 0, "SDK activity remains queued");
        tx.execute(SAVE_CHECKPOINT, params![handoff.marker(), "{}"])?;
        tx.commit()?;
        Ok(())
    }

    pub fn checkpoint(&self, source: &str, text: &str) -> anyhow::Result<()> {
        self.db
            .lock()
            .unwrap()
            .prepare_cached(SAVE_CHECKPOINT)?
            .execute(params![source, text])?;
        Ok(())
    }
    async fn accept(
        &self,
        source: &str,
        store: &StateStore,
        encoded: &[Vec<u8>],
        usage: &UsageUpdates,
        cancelled: &AtomicBool,
    ) -> anyhow::Result<()> {
        let bytes = encoded.iter().map(Vec::len).sum::<usize>();
        loop {
            let notified = self.capacity_changed.notified();
            anyhow::ensure!(
                !cancelled.load(Ordering::SeqCst),
                "source acceptance cancelled; durable progress retained"
            );
            let options = self.options.read().unwrap().clone();
            // Oversized data is retained in this uncommitted cycle; reads pause
            // until settings change or stop preserves the old durable cursor.
            if encoded.iter().any(|e| e.len() > options.max_event_bytes)
                || bytes > options.queue_memory_bytes
                || bytes > options.queue_disk_bytes
            {
                self.alarm(
                    "SDK_EVENT_OVERSIZE",
                    "source cycle exceeds delivery capacity; source progress is retained",
                );
            } else {
                let accepted = {
                    let mut db = self.db.lock().unwrap();
                    let tx = db.transaction()?;
                    let used: usize =
                        tx.query_row("SELECT bytes FROM queue_size WHERE singleton=1", [], |r| {
                            r.get::<_, i64>(0)
                        })? as usize;
                    if used.saturating_add(bytes) <= options.queue_disk_bytes {
                        let batch = uuid::Uuid::new_v4().to_string();
                        let created = chrono::Utc::now().timestamp_millis();
                        {
                            let mut insert = tx.prepare_cached(
                                "INSERT INTO event(source,batch,payload,created) VALUES(?1,?2,?3,?4)",
                            )?;
                            for row in encoded {
                                insert.execute(params![source, batch, row, created])?;
                            }
                        }
                        Self::update_queue_size(&tx, bytes as i64, encoded.len() as i64)?;
                        for ((agent, day), totals) in usage {
                            tx.execute("INSERT INTO token_usage VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(agent,day) DO UPDATE SET responses=CASE WHEN responses>9223372036854775807-excluded.responses THEN 9223372036854775807 ELSE responses+excluded.responses END,with_usage=CASE WHEN with_usage>9223372036854775807-excluded.with_usage THEN 9223372036854775807 ELSE with_usage+excluded.with_usage END,input=CASE WHEN input>9223372036854775807-excluded.input THEN 9223372036854775807 ELSE input+excluded.input END,output=CASE WHEN output>9223372036854775807-excluded.output THEN 9223372036854775807 ELSE output+excluded.output END,cache_read=CASE WHEN cache_read>9223372036854775807-excluded.cache_read THEN 9223372036854775807 ELSE cache_read+excluded.cache_read END,cache_creation=CASE WHEN cache_creation>9223372036854775807-excluded.cache_creation THEN 9223372036854775807 ELSE cache_creation+excluded.cache_creation END",
                                params![agent,day,totals[0],totals[1],totals[2],totals[3],totals[4],totals[5]])?;
                        }
                        tx.prepare_cached(SAVE_CHECKPOINT)?
                            .execute(params![source, store.snapshot_text()])?;
                        tx.commit()?;
                        true
                    } else {
                        false
                    }
                };
                if accepted {
                    self.accepted_events
                        .fetch_add(encoded.len() as u64, Ordering::SeqCst);
                    self.accepted_bytes
                        .fetch_add(bytes as u64, Ordering::SeqCst);
                    self.wake();
                    return Ok(());
                }
                self.alarm(
                    "SDK_QUEUE_FULL",
                    "delivery queue is full; source reading is paused",
                );
            }
            tokio::select! {_=notified=>{},_=tokio::time::sleep(Duration::from_millis(100))=>{}}
        }
    }

    pub fn deliver(self: Arc<Self>, callback: OnBatch, context: usize) {
        let mut retry_since = None;
        let mut delay = 0u64;
        let mut last_alarm = None;
        while !self.stopping.load(Ordering::SeqCst) {
            let options = self.options.read().unwrap().clone();
            let (rows, wait) = match self.delivery_batch(&options) {
                Ok(batch) => batch,
                Err(error) => {
                    self.alarm("SDK_OUTBOX_READ", &error.to_string());
                    self.wait(Duration::from_secs(1));
                    continue;
                }
            };
            if rows.is_empty() {
                self.wait(wait);
                continue;
            }
            let views: Vec<_> = rows
                .iter()
                .map(|(_, row)| PilotJsonView::from_bytes(row))
                .collect();
            self.callbacks.fetch_add(1, Ordering::SeqCst);
            let callback_started = Instant::now();
            // SAFETY: owned immutable payloads/views remain live until callback
            // return. The host retains its context until successful destroy.
            let ack = unsafe { callback(context as *mut _, views.as_ptr(), views.len()) };
            self.callback_duration_us.fetch_add(
                callback_started.elapsed().as_micros().min(u64::MAX as u128) as u64,
                Ordering::SeqCst,
            );
            self.callbacks.fetch_sub(1, Ordering::SeqCst);
            if ack != ACK && ack != 1 {
                self.alarm(
                    "SDK_CALLBACK_PROTOCOL",
                    "unknown activity callback return value; retained for RETRY",
                );
            }
            drop(views);
            let result = if ack == ACK {
                self.ack(&rows)
            } else {
                Err(anyhow::anyhow!(if ack == 1 {
                    "host requested RETRY"
                } else {
                    "invalid callback result; treated as RETRY"
                }))
            };
            // Retry reloads the same durable rows. Release the in-memory
            // batch before entering the backoff wait.
            drop(rows);
            match result {
                Ok(()) => {
                    delay = 0;
                    retry_since = None;
                    last_alarm = None;
                    self.capacity_changed.notify_waiters();
                }
                Err(error) => {
                    self.retries.fetch_add(1, Ordering::SeqCst);
                    let since = *retry_since.get_or_insert_with(Instant::now);
                    if since.elapsed() >= Duration::from_millis(options.retry_alarm_after_ms)
                        && last_alarm.is_none_or(|at: Instant| {
                            at.elapsed() >= Duration::from_millis(options.alarm_repeat_ms)
                        })
                    {
                        self.alarm("SDK_DELIVERY_RETRY", &error.to_string());
                        last_alarm = Some(Instant::now());
                    }
                    delay = if delay == 0 {
                        options.retry_initial_ms
                    } else {
                        delay.saturating_mul(2).min(options.retry_max_ms)
                    };
                    let jitter = self.retries.load(Ordering::SeqCst) % (delay / 10 + 1);
                    self.wait(Duration::from_millis(
                        delay.saturating_add(jitter).min(options.retry_max_ms),
                    ));
                }
            }
        }
    }
    fn delivery_batch(&self, options: &Delivery) -> anyhow::Result<(DeliveryRows, Duration)> {
        let db = self.db.lock().unwrap();
        let (events, bytes): (usize, usize) = db
            .prepare_cached("SELECT events,bytes FROM queue_size WHERE singleton=1")?
            .query_row([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        let interval = Duration::from_millis(options.flush_interval_ms);
        if events == 0 {
            return Ok((Vec::new(), interval));
        }
        let now = chrono::Utc::now().timestamp_millis();
        let remaining = |oldest| {
            u64::try_from(now.saturating_sub(oldest)).map_or(Duration::ZERO, |age| {
                interval.saturating_sub(Duration::from_millis(age))
            })
        };
        if events < options.max_events_per_batch
            && bytes < options.max_batch_bytes
            && bytes <= options.max_event_bytes
        {
            // The aggregate size also rules out oversized individual events.
            // A partial batch only needs its oldest timestamp to decide when to read.
            let oldest: i64 = db
                .prepare_cached("SELECT created FROM event ORDER BY seq LIMIT 1")?
                .query_row([], |row| row.get(0))?;
            let wait = remaining(oldest);
            if !wait.is_zero() {
                return Ok((Vec::new(), wait));
            }
        }

        let (rows, oldest) = Self::select_batch(&db, options)?;
        let bytes = rows.iter().map(|(_, row)| row.len()).sum::<usize>();
        let wait = remaining(oldest);
        if rows.len() < options.max_events_per_batch
            && bytes < options.max_batch_bytes
            && !wait.is_zero()
        {
            return Ok((Vec::new(), wait));
        }
        Ok((rows, Duration::ZERO))
    }

    #[cfg(test)]
    pub(crate) fn read_batch(&self, options: &Delivery) -> anyhow::Result<(DeliveryRows, i64)> {
        Self::select_batch(&self.db.lock().unwrap(), options)
    }

    fn select_batch(db: &Connection, options: &Delivery) -> anyhow::Result<(DeliveryRows, i64)> {
        let mut stmt = db.prepare_cached(
            "SELECT seq,payload,created,length(payload) FROM event ORDER BY seq LIMIT ?1",
        )?;
        let mut found = stmt.query([options.max_events_per_batch as i64])?;
        let mut rows = Vec::new();
        let mut bytes = 0;
        let mut oldest = 0;
        while let Some(row) = found.next()? {
            let length: usize = row.get(3)?;
            anyhow::ensure!(
                length <= options.max_event_bytes && length <= options.max_batch_bytes,
                "retained head event exceeds current limit"
            );
            if bytes + length > options.max_batch_bytes {
                break;
            }
            let data: Vec<u8> = row.get(1)?;
            if !rows.is_empty()
                && (bytes + data.len() > options.max_batch_bytes
                    || data.len() > options.max_event_bytes)
            {
                break;
            }
            if rows.is_empty() {
                oldest = row.get(2)?;
            }
            bytes += data.len();
            rows.push((row.get(0)?, data));
        }
        Ok((rows, oldest))
    }
    /// Update logical limits in the same durable transaction as the rows.
    /// The previous schema ran these updates from per-row triggers.
    fn update_queue_size(tx: &Connection, bytes: i64, events: i64) -> anyhow::Result<()> {
        let changed = tx
            .prepare_cached(
                "UPDATE queue_size SET bytes=bytes+?1,events=events+?2 WHERE singleton=1",
            )?
            .execute(params![bytes, events])?;
        anyhow::ensure!(changed == 1, "SDK outbox queue counters missing");
        Ok(())
    }

    pub(crate) fn ack(&self, rows: &[(i64, Vec<u8>)]) -> anyhow::Result<()> {
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction()?;
        let now = chrono::Utc::now().timestamp_millis();
        let mut delay = 0u64;
        let mut acknowledged_bytes = 0_i64;
        {
            let mut delete = tx.prepare_cached(
                "DELETE FROM event WHERE seq=?1 RETURNING created,length(payload)",
            )?;
            for (id, _) in rows {
                let (created, bytes): (i64, i64) =
                    delete.query_row([id], |row| Ok((row.get(0)?, row.get(1)?)))?;
                delay = delay.saturating_add(now.saturating_sub(created).max(0) as u64);
                acknowledged_bytes += bytes;
            }
        }
        Self::update_queue_size(&tx, -acknowledged_bytes, -(rows.len() as i64))?;
        tx.commit()?;
        self.total_delay_ms.fetch_add(delay, Ordering::SeqCst);
        self.last_ack_ms.store(now.max(0) as u64, Ordering::SeqCst);
        self.acked_events
            .fetch_add(rows.len() as u64, Ordering::SeqCst);
        self.acked_bytes.fetch_add(
            rows.iter().map(|(_, r)| r.len() as u64).sum::<u64>(),
            Ordering::SeqCst,
        );
        // FULL synchronous commits still guard every acknowledgement. Limit
        // physical compaction work while SQLite reuses live WAL pages.
        let mut last = self.last_disk_compaction.lock().unwrap();
        if last.elapsed() >= Duration::from_millis(500) {
            let _ =
                db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA incremental_vacuum(64);");
            *last = Instant::now();
        }
        Ok(())
    }
    pub fn alarm_batch(&self) -> Vec<(String, String)> {
        let db = self.db.lock().unwrap();
        let Ok(mut stmt) = db.prepare("SELECT kind,json FROM alarm LIMIT 128") else {
            return Vec::new();
        };
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }
    pub fn ack_alarms(&self, values: &[(String, String)]) {
        let db = self.db.lock().unwrap();
        for (kind, value) in values {
            let _ = db.execute(
                "DELETE FROM alarm WHERE kind=?1 AND json=?2",
                params![kind, value],
            );
        }
    }
}

pub struct CallbackOutboxFlusher {
    pub queue: Arc<Outbox>,
    pub source: String,
    pub store: Arc<StateStore>,
    pub cancelled: Arc<AtomicBool>,
}
impl CallbackOutboxFlusher {
    async fn accept_rows(
        &self,
        encoded: &[Vec<u8>],
        usage: &UsageUpdates,
    ) -> Result<(), FlushError> {
        self.queue
            .accept(&self.source, &self.store, encoded, usage, &self.cancelled)
            .await
            .map_err(|e| FlushError::output_durability("SDK", &e.to_string()))
    }
}

#[async_trait]
impl BaseFlusher for CallbackOutboxFlusher {
    fn uses_prepared_batch(&self) -> bool {
        true
    }

    fn name(&self) -> &str {
        "callback-outbox"
    }
    async fn send(&self, entry: AgentActivityEntry, _: Option<f64>) -> Result<(), FlushError> {
        self.send_batch(vec![entry], None).await
    }
    async fn send_batch(
        &self,
        entries: Vec<AgentActivityEntry>,
        _: Option<Vec<f64>>,
    ) -> Result<(), FlushError> {
        let (encoded, usage) =
            prepare_owned_rows(entries).map_err(|e| FlushError::new(e.to_string()))?;
        self.accept_rows(&encoded, &usage).await
    }
    async fn deliver_owned_batch(
        &self,
        entries: Vec<AgentActivityEntry>,
        _: Arc<QuotaAlarm>,
    ) -> Result<(u64, Result<(), FlushError>), serde_json::Error> {
        let (encoded, usage) = prepare_owned_rows(entries)?;
        let bytes = encoded.iter().map(|row| row.len() as u64).sum();
        let result = self.accept_rows(&encoded, &usage).await;
        Ok((bytes, result))
    }
    async fn send_prepared_batch(
        &self,
        entries: Vec<AgentActivityEntry>,
        encoded: Vec<Vec<u8>>,
    ) -> Result<(), FlushError> {
        let usage = usage_updates(&entries);
        // Backpressure only needs the serialized payload and the small usage summary.
        drop(entries);
        self.accept_rows(&encoded, &usage).await
    }
    async fn flush(&self) -> Result<(), FlushError> {
        Ok(())
    }
    async fn shutdown(&self) -> Result<(), FlushError> {
        Ok(())
    }
}

pub(super) fn write_checkpoint(path: &Path, text: &str) -> anyhow::Result<()> {
    use std::io::Write;
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("checkpoint parent"))?;
    crate::utils::source_access::private_path(path)?;
    std::fs::create_dir_all(parent)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    temp.write_all(text.as_bytes())?;
    temp.as_file().sync_all()?;
    temp.persist(path)?;
    Ok(())
}
#[cfg(test)]
#[path = "outbox_tests.rs"]
mod tests;
