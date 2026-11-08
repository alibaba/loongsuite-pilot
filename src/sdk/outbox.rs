//! One durable transaction contains both a source checkpoint and its events.
//! The JSON checkpoint remains compatible; SQLite is authoritative after a crash.
use super::abi::{OnBatch, PilotJsonView, ACK};
use super::policy::Delivery;
use crate::checkpoints::StateStore;
use crate::flushers::{BaseFlusher, FlushError};
use crate::types::AgentActivityEntry;
use async_trait::async_trait;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::time::{Duration, Instant};

type DeliveryRows = Vec<(i64, Vec<u8>)>;

#[derive(serde::Deserialize)]
struct UsageProjection {
    #[serde(rename = "event.name", default)]
    event: String,
    #[serde(rename = "gen_ai.agent.type", default)]
    agent: String,
    #[serde(default)]
    time_unix_nano: String,
    #[serde(rename = "gen_ai.usage.input_tokens")]
    input: Option<i64>,
    #[serde(rename = "gen_ai.usage.output_tokens")]
    output: Option<i64>,
    #[serde(rename = "gen_ai.usage.cache_read.input_tokens")]
    cache_read: Option<i64>,
    #[serde(rename = "gen_ai.usage.cache_creation.input_tokens")]
    cache_creation: Option<i64>,
}

fn usage_updates(rows: &[Vec<u8>]) -> std::collections::BTreeMap<(String, String), [i64; 6]> {
    let mut totals = std::collections::BTreeMap::new();
    for bytes in rows {
        let Ok(row) = serde_json::from_slice::<UsageProjection>(bytes) else {
            continue;
        };
        if row.event != "llm.response" || row.agent.is_empty() {
            continue;
        }
        let Some(day) = row
            .time_unix_nano
            .parse::<i64>()
            .ok()
            .filter(|n| *n > 0)
            .and_then(|n| chrono::DateTime::from_timestamp(n / 1_000_000_000, 0))
        else {
            continue;
        };
        let value = totals
            .entry((row.agent, day.format("%Y-%m-%d").to_string()))
            .or_insert([0i64; 6]);
        let delta = [
            1,
            i64::from(row.input.is_some() || row.output.is_some()),
            row.input.unwrap_or(0),
            row.output.unwrap_or(0),
            row.cache_read.unwrap_or(0),
            row.cache_creation.unwrap_or(0),
        ];
        for (sum, v) in value.iter_mut().zip(delta) {
            *sum = sum.saturating_add(v.max(0));
        }
    }
    totals
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
    pub hook_timings: Mutex<Vec<crate::metrics::HookTimingStats>>,
    pub callback_duration_us: AtomicU64,
    pub total_delay_ms: AtomicU64,
    pub last_ack_ms: AtomicU64,
    pub start_time: String,
    pub path: PathBuf,
}

impl Outbox {
    pub fn open(root: &Path, options: Delivery) -> anyhow::Result<Arc<Self>> {
        crate::utils::source_access::private_path(root)?;
        std::fs::create_dir_all(root)?;
        let path = root.join("delivery.sqlite");
        for suffix in ["", "-wal", "-shm"] {
            crate::utils::source_access::private_path(
                &root.join(format!("delivery.sqlite{suffix}")),
            )?;
        }
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
            CREATE TRIGGER IF NOT EXISTS event_accepted AFTER INSERT ON event BEGIN
                UPDATE queue_size SET bytes=bytes+length(NEW.payload),events=events+1 WHERE singleton=1; END;
            CREATE TRIGGER IF NOT EXISTS event_acked AFTER DELETE ON event BEGIN
                UPDATE queue_size SET bytes=bytes-length(OLD.payload),events=events-1 WHERE singleton=1; END;")?;
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
            start_time: chrono::Utc::now().to_rfc3339(),
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
    pub fn restore(&self, source: &str, path: &Path) -> anyhow::Result<()> {
        use rusqlite::OptionalExtension;
        let checkpoint = self
            .db
            .lock()
            .unwrap()
            .query_row(
                "SELECT json FROM checkpoint WHERE source=?1",
                [source],
                |r| r.get::<_, String>(0),
            )
            .optional()?;
        crate::utils::source_access::private_path(path)?;
        if let Some(text) = checkpoint {
            std::fs::create_dir_all(
                path.parent()
                    .ok_or_else(|| anyhow::anyhow!("checkpoint parent"))?,
            )?;
            std::fs::write(path, text)?;
        }
        Ok(())
    }
    pub fn checkpoint(&self, source: &str, text: &str) -> anyhow::Result<()> {
        self.db.lock().unwrap().execute("INSERT INTO checkpoint VALUES(?1,?2) ON CONFLICT(source) DO UPDATE SET json=excluded.json",params![source,text])?;
        Ok(())
    }
    async fn accept(
        &self,
        source: &str,
        store: &StateStore,
        encoded: &[Vec<u8>],
        cancelled: &AtomicBool,
    ) -> anyhow::Result<()> {
        let bytes = encoded.iter().map(Vec::len).sum::<usize>();
        let usage = usage_updates(encoded);
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
                        for row in encoded {
                            tx.execute("INSERT INTO event(source,batch,payload,created) VALUES(?1,?2,?3,?4)",params![source,batch,row,chrono::Utc::now().timestamp_millis()])?;
                        }
                        for ((agent, day), totals) in &usage {
                            tx.execute("INSERT INTO token_usage VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(agent,day) DO UPDATE SET responses=CASE WHEN responses>9223372036854775807-excluded.responses THEN 9223372036854775807 ELSE responses+excluded.responses END,with_usage=CASE WHEN with_usage>9223372036854775807-excluded.with_usage THEN 9223372036854775807 ELSE with_usage+excluded.with_usage END,input=CASE WHEN input>9223372036854775807-excluded.input THEN 9223372036854775807 ELSE input+excluded.input END,output=CASE WHEN output>9223372036854775807-excluded.output THEN 9223372036854775807 ELSE output+excluded.output END,cache_read=CASE WHEN cache_read>9223372036854775807-excluded.cache_read THEN 9223372036854775807 ELSE cache_read+excluded.cache_read END,cache_creation=CASE WHEN cache_creation>9223372036854775807-excluded.cache_creation THEN 9223372036854775807 ELSE cache_creation+excluded.cache_creation END",
                                params![agent,day,totals[0],totals[1],totals[2],totals[3],totals[4],totals[5]])?;
                        }
                        tx.execute("INSERT INTO checkpoint VALUES(?1,?2) ON CONFLICT(source) DO UPDATE SET json=excluded.json",params![source,store.snapshot_text()])?;
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
            let selected = self.read_batch(&options);
            let (rows, oldest) = match selected {
                Ok(v) => v,
                Err(e) => {
                    self.alarm("SDK_OUTBOX_READ", &e.to_string());
                    self.wait(Duration::from_millis(1000));
                    continue;
                }
            };
            if rows.is_empty() {
                self.wait(Duration::from_millis(options.flush_interval_ms));
                continue;
            }
            let bytes = rows.iter().map(|(_, row)| row.len()).sum::<usize>();
            if rows[0].1.len() > options.max_event_bytes
                || rows[0].1.len() > options.max_batch_bytes
            {
                self.alarm(
                    "SDK_EVENT_OVERSIZE",
                    "retained event exceeds current delivery limit",
                );
                self.wait(Duration::from_millis(1000));
                continue;
            }
            let age = chrono::Utc::now().timestamp_millis().saturating_sub(oldest) as u64;
            if rows.len() < options.max_events_per_batch
                && bytes < options.max_batch_bytes
                && age < options.flush_interval_ms
            {
                self.wait(Duration::from_millis(options.flush_interval_ms - age));
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
            let result = if ack == ACK {
                self.ack(&rows)
            } else {
                Err(anyhow::anyhow!(if ack == 1 {
                    "host requested RETRY"
                } else {
                    "invalid callback result; treated as RETRY"
                }))
            };
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
    fn read_batch(&self, options: &Delivery) -> anyhow::Result<(DeliveryRows, i64)> {
        let db = self.db.lock().unwrap();
        let mut stmt = db.prepare(
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
    fn ack(&self, rows: &[(i64, Vec<u8>)]) -> anyhow::Result<()> {
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction()?;
        let now = chrono::Utc::now().timestamp_millis();
        let mut delay = 0u64;
        for (id, _) in rows {
            let created: i64 = tx.query_row(
                "DELETE FROM event WHERE seq=?1 RETURNING created",
                [id],
                |r| r.get(0),
            )?;
            delay = delay.saturating_add(now.saturating_sub(created).max(0) as u64);
        }
        tx.commit()?;
        self.total_delay_ms.fetch_add(delay, Ordering::SeqCst);
        self.last_ack_ms.store(now.max(0) as u64, Ordering::SeqCst);
        self.acked_events
            .fetch_add(rows.len() as u64, Ordering::SeqCst);
        self.acked_bytes.fetch_add(
            rows.iter().map(|(_, r)| r.len() as u64).sum::<u64>(),
            Ordering::SeqCst,
        );
        let _ = db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA incremental_vacuum(64);");
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
        let encoded = entries
            .iter()
            .map(serde_json::to_vec)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| FlushError::new(e.to_string()))?;
        self.send_prepared_batch(entries, encoded).await
    }
    async fn send_prepared_batch(
        &self,
        _: Vec<AgentActivityEntry>,
        encoded: Vec<Vec<u8>>,
    ) -> Result<(), FlushError> {
        self.queue
            .accept(&self.source, &self.store, &encoded, &self.cancelled)
            .await
            .map_err(|e| FlushError::output_durability("SDK", &e.to_string()))
    }
    async fn flush(&self) -> Result<(), FlushError> {
        Ok(())
    }
    async fn shutdown(&self) -> Result<(), FlushError> {
        Ok(())
    }
}

#[cfg(test)]
#[path = "outbox_tests.rs"]
mod tests;
