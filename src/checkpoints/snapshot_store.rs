//! Snapshot dedup checkpoint.
//!
//! Entries are stored on disk as an array in insertion order. `load` ignores
//! the file's `highWatermark` and rebuilds it from processed timestamps.
//! `flush` prunes expired entries before writing.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::json_file::{self, JVal};
use super::OrderedMap;

const DEFAULT_RETENTION_MS: f64 = (7 * 24 * 60 * 60 * 1000) as f64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SnapshotStatus {
    Pending,
    Processed,
}

impl SnapshotStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Processed => "processed",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct SnapshotEntry {
    pub key: String,
    pub timestamp: f64,
    pub seen_at: f64,
    pub status: SnapshotStatus,
    pub reason: Option<String>,
}

#[derive(Debug)]
struct SnapshotData {
    entries: OrderedMap<SnapshotEntry>,
    high_watermark: f64,
    dirty: bool,
}

impl Default for SnapshotData {
    fn default() -> Self {
        Self {
            entries: OrderedMap::default(),
            high_watermark: 0.0,
            dirty: false,
        }
    }
}

/// Dedup map for IDE history snapshots.
pub struct SnapshotStore {
    file_path: PathBuf,
    retention_ms: f64,
    inner: Mutex<SnapshotData>,
    now_override: Mutex<Option<f64>>,
}

impl SnapshotStore {
    pub fn new(file_path: impl AsRef<Path>) -> Self {
        Self::with_retention(file_path, DEFAULT_RETENTION_MS)
    }

    pub fn with_retention(file_path: impl AsRef<Path>, retention_ms: f64) -> Self {
        Self {
            file_path: file_path.as_ref().to_path_buf(),
            retention_ms,
            inner: Mutex::new(SnapshotData::default()),
            now_override: Mutex::new(None),
        }
    }

    pub async fn load(&self) {
        let parsed = json_file::read_json(&self.file_path).await;
        let mut data = self.inner.lock().unwrap();
        data.entries.clear();
        let items = match parsed {
            Some(JVal::Object(fields)) => match take_field(fields, "entries") {
                Some(JVal::Array(items)) => items,
                Some(
                    JVal::Object(_)
                    | JVal::Null
                    | JVal::Bool(_)
                    | JVal::Number(_)
                    | JVal::String(_),
                )
                | None => {
                    data.high_watermark = 0.0;
                    data.dirty = false;
                    return;
                }
            },
            Some(
                JVal::Array(_) | JVal::Null | JVal::Bool(_) | JVal::Number(_) | JVal::String(_),
            )
            | None => {
                data.high_watermark = 0.0;
                data.dirty = false;
                return;
            }
        };
        for item in items {
            if let Some(entry) = parse_entry(&item) {
                data.entries.insert(entry.key.clone(), entry);
            }
        }
        data.high_watermark = rebuild_high_watermark(&data.entries);
        data.dirty = false;
    }

    pub async fn flush(&self) -> Result<(), anyhow::Error> {
        let now = self.now_ms();
        let text = {
            let mut data = self.inner.lock().unwrap();
            prune(&mut data, now, self.retention_ms);
            data.high_watermark = rebuild_high_watermark(&data.entries);
            if !data.dirty {
                return Ok(());
            }
            // Snapshot the file body before the await. `dirty` is cleared only
            // after the write returns, matching the TypeScript flush.
            render(&data)
        };
        json_file::write_text_atomic(&self.file_path, &text).await?;
        self.inner.lock().unwrap().dirty = false;
        Ok(())
    }

    pub fn should_process(&self, key: &str) -> bool {
        !self.inner.lock().unwrap().entries.contains(key)
    }

    pub fn mark_pending(&self, key: &str, timestamp: f64) {
        let seen_at = self.now_ms();
        let mut data = self.inner.lock().unwrap();
        data.entries.insert(
            key.to_owned(),
            SnapshotEntry {
                key: key.to_owned(),
                timestamp,
                seen_at,
                status: SnapshotStatus::Pending,
                reason: None,
            },
        );
        data.dirty = true;
    }

    /// `reason == None` keeps the previous reason. Unknown keys are ignored.
    pub fn mark_processed(&self, key: &str, reason: Option<&str>) {
        let mut data = self.inner.lock().unwrap();
        if !data.entries.contains(key) {
            drop(data);
            tracing::warn!(target: "SnapshotStore", key, "markProcessed: unknown key");
            return;
        }
        let entry = data.entries.get_mut(key).expect("snapshot entry exists");
        entry.status = SnapshotStatus::Processed;
        if let Some(reason) = reason {
            entry.reason = Some(reason.to_owned());
        }
        let timestamp = entry.timestamp;
        data.high_watermark = js_max(data.high_watermark, timestamp);
        data.dirty = true;
    }

    pub fn get_suggested_since_timestamp(&self) -> f64 {
        let floor = self.now_ms() - self.retention_ms;
        let high_watermark = self.inner.lock().unwrap().high_watermark;
        js_max(high_watermark, floor)
    }

    pub fn size(&self) -> usize {
        self.inner.lock().unwrap().entries.len()
    }

    fn now_ms(&self) -> f64 {
        if let Some(now) = *self.now_override.lock().unwrap() {
            return now;
        }
        json_file::system_now_ms() as f64
    }

    #[cfg(test)]
    fn set_now_ms(&self, now_ms: i64) {
        *self.now_override.lock().unwrap() = Some(now_ms as f64);
    }
}

fn prune(data: &mut SnapshotData, now: f64, retention_ms: f64) {
    let stale: Vec<String> = data
        .entries
        .iter()
        .filter(|(_, entry)| now - entry.seen_at > retention_ms)
        .map(|(key, _)| key.to_owned())
        .collect();
    if stale.is_empty() {
        return;
    }
    for key in stale {
        data.entries.remove(&key);
        data.dirty = true;
    }
}

fn rebuild_high_watermark(entries: &OrderedMap<SnapshotEntry>) -> f64 {
    let mut max = 0.0;
    for (_, entry) in entries.iter() {
        if entry.status == SnapshotStatus::Processed && entry.timestamp > max {
            max = entry.timestamp;
        }
    }
    max
}

fn js_max(left: f64, right: f64) -> f64 {
    if left.is_nan() || right.is_nan() {
        f64::NAN
    } else if left > right {
        left
    } else {
        right
    }
}

fn render(data: &SnapshotData) -> String {
    let entries: Vec<JVal> = data
        .entries
        .iter()
        .map(|(_, entry)| entry_to_jval(entry))
        .collect();
    let root = JVal::Object(vec![
        (
            "highWatermark".to_owned(),
            json_file::number_from_f64(data.high_watermark),
        ),
        ("entries".to_owned(), JVal::Array(entries)),
    ]);
    format!("{}\n", json_file::to_pretty(&root))
}

fn entry_to_jval(entry: &SnapshotEntry) -> JVal {
    let mut fields = vec![
        ("key".to_owned(), JVal::String(entry.key.clone())),
        (
            "timestamp".to_owned(),
            json_file::number_from_f64(entry.timestamp),
        ),
        (
            "seenAt".to_owned(),
            json_file::number_from_f64(entry.seen_at),
        ),
        (
            "status".to_owned(),
            JVal::String(entry.status.as_str().to_owned()),
        ),
    ];
    if let Some(reason) = &entry.reason {
        fields.push(("reason".to_owned(), JVal::String(reason.clone())));
    }
    JVal::Object(fields)
}

fn take_field(mut fields: Vec<(String, JVal)>, key: &str) -> Option<JVal> {
    let index = fields.iter().position(|(candidate, _)| candidate == key)?;
    Some(fields.swap_remove(index).1)
}

fn parse_entry(value: &JVal) -> Option<SnapshotEntry> {
    let JVal::Object(fields) = value else {
        return None;
    };
    let key = match field(fields, "key") {
        Some(JVal::String(key)) => key.clone(),
        Some(JVal::Null)
        | Some(JVal::Bool(_))
        | Some(JVal::Number(_))
        | Some(JVal::Array(_))
        | Some(JVal::Object(_))
        | None => return None,
    };
    let timestamp = js_number_or_zero(field(fields, "timestamp"));
    let seen_at = js_number_or_zero(field(fields, "seenAt"));
    let status = match field(fields, "status").and_then(jval_str) {
        Some("processed") => SnapshotStatus::Processed,
        Some(_) | None => SnapshotStatus::Pending,
    };
    let reason = match field(fields, "reason") {
        Some(JVal::String(reason)) => Some(reason.clone()),
        Some(JVal::Null)
        | Some(JVal::Bool(_))
        | Some(JVal::Number(_))
        | Some(JVal::Array(_))
        | Some(JVal::Object(_))
        | None => None,
    };
    Some(SnapshotEntry {
        key,
        timestamp,
        seen_at,
        status,
        reason,
    })
}

fn field<'a>(fields: &'a [(String, JVal)], key: &str) -> Option<&'a JVal> {
    fields
        .iter()
        .find(|(candidate, _)| candidate == key)
        .map(|(_, value)| value)
}

fn jval_str(value: &JVal) -> Option<&str> {
    match value {
        JVal::String(value) => Some(value.as_str()),
        JVal::Null | JVal::Bool(_) | JVal::Number(_) | JVal::Array(_) | JVal::Object(_) => None,
    }
}

/// `Number(value) || 0` for the JSON values checkpoints actually store.
fn js_number_or_zero(value: Option<&JVal>) -> f64 {
    let Some(value) = value else {
        return 0.0;
    };
    let number = js_number(value);
    if number.is_finite() && number != 0.0 {
        number
    } else {
        0.0
    }
}

fn js_number(value: &JVal) -> f64 {
    match value {
        JVal::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        JVal::String(text) => parse_js_number_string(text),
        JVal::Bool(true) => 1.0,
        JVal::Bool(false) => 0.0,
        JVal::Null => 0.0,
        JVal::Array(items) if items.is_empty() => 0.0,
        JVal::Array(items) if items.len() == 1 => js_number(&items[0]),
        JVal::Array(_) | JVal::Object(_) => f64::NAN,
    }
}

fn parse_js_number_string(text: &str) -> f64 {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        0.0
    } else {
        trimmed.parse::<f64>().unwrap_or(f64::NAN)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup(name: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join(name);
        (dir, file_path)
    }

    #[tokio::test]
    async fn should_process_unseen_keys() {
        let (_dir, file_path) = setup("snapshot.json");
        let store = SnapshotStore::new(&file_path);
        assert!(store.should_process("key-1"));
    }

    #[tokio::test]
    async fn should_not_process_pending_keys() {
        let (_dir, file_path) = setup("snapshot.json");
        let store = SnapshotStore::new(&file_path);
        store.mark_pending("key-1", unix_now());
        assert!(!store.should_process("key-1"));
    }

    #[tokio::test]
    async fn should_not_process_processed_keys() {
        let (_dir, file_path) = setup("snapshot.json");
        let store = SnapshotStore::new(&file_path);
        store.mark_pending("key-1", unix_now());
        store.mark_processed("key-1", None);
        assert!(!store.should_process("key-1"));
    }

    #[tokio::test]
    async fn transitions_from_pending_to_processed() {
        let (_dir, file_path) = setup("snapshot.json");
        let store = SnapshotStore::new(&file_path);
        store.mark_pending("k", 1000.0);
        store.mark_processed("k", None);
        assert!(!store.should_process("k"));
    }

    #[tokio::test]
    async fn tracks_size() {
        let (_dir, file_path) = setup("snapshot.json");
        let store = SnapshotStore::new(&file_path);
        assert_eq!(store.size(), 0);
        store.mark_pending("a", 100.0);
        assert_eq!(store.size(), 1);
        store.mark_pending("b", 200.0);
        assert_eq!(store.size(), 2);
    }

    #[tokio::test]
    async fn updates_high_watermark_on_mark_processed() {
        let (_dir, file_path) = setup("snapshot.json");
        let store = SnapshotStore::new(&file_path);
        store.mark_pending("a", 1000.0);
        store.mark_processed("a", None);
        store.mark_pending("b", 2000.0);
        store.mark_processed("b", None);
        assert!(store.get_suggested_since_timestamp() >= 2000.0);
    }

    #[tokio::test]
    async fn high_watermark_is_the_max_processed_timestamp() {
        let (_dir, file_path) = setup("snapshot.json");
        let store = SnapshotStore::with_retention(&file_path, 100_000.0);
        store.set_now_ms(10_000);
        store.mark_pending("a", 1000.0);
        store.mark_processed("a", None);
        store.mark_pending("b", 2000.0);
        store.mark_processed("b", None);
        assert_eq!(store.get_suggested_since_timestamp(), 2000.0);
    }

    #[tokio::test]
    async fn uses_retention_floor_when_high_watermark_is_zero() {
        let (_dir, file_path) = setup("snapshot.json");
        let retention_ms = 100_000.0;
        let store = SnapshotStore::with_retention(&file_path, retention_ms);
        store.set_now_ms(1_000_000_000);
        assert_eq!(
            store.get_suggested_since_timestamp(),
            1_000_000_000.0 - retention_ms
        );
    }

    #[tokio::test]
    async fn prunes_entries_older_than_retention_on_flush() {
        let (_dir, file_path) = setup("snapshot.json");
        let retention_ms = 500.0;
        let store = SnapshotStore::with_retention(&file_path, retention_ms);
        store.set_now_ms(1000);
        store.mark_pending("old", 100.0);
        store.mark_processed("old", None);
        store.set_now_ms(1600);
        store.mark_pending("new", 1500.0);
        store.mark_processed("new", None);
        store.flush().await.unwrap();
        assert_eq!(store.size(), 1);
        assert!(store.should_process("old"));
        assert!(!store.should_process("new"));
    }

    #[tokio::test]
    async fn persists_and_restores_state() {
        let (_dir, file_path) = setup("snapshot.json");
        let store1 = SnapshotStore::new(&file_path);
        store1.set_now_ms(111);
        store1.mark_pending("key-a", 1000.0);
        store1.mark_processed("key-a", None);
        store1.mark_pending("key-b", 2000.0);
        store1.flush().await.unwrap();

        let body = tokio::fs::read_to_string(&file_path).await.unwrap();
        assert_eq!(
            body,
            "{\n  \"highWatermark\": 1000,\n  \"entries\": [\n    {\n      \"key\": \"key-a\",\n      \"timestamp\": 1000,\n      \"seenAt\": 111,\n      \"status\": \"processed\"\n    },\n    {\n      \"key\": \"key-b\",\n      \"timestamp\": 2000,\n      \"seenAt\": 111,\n      \"status\": \"pending\"\n    }\n  ]\n}\n"
        );

        let store2 = SnapshotStore::new(&file_path);
        store2.load().await;
        assert!(!store2.should_process("key-a"));
        assert!(!store2.should_process("key-b"));
        assert_eq!(store2.size(), 2);
    }

    #[tokio::test]
    async fn handles_missing_file_on_load() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing.json");
        let store = SnapshotStore::new(&missing);
        store.load().await;
        assert_eq!(store.size(), 0);
    }

    #[tokio::test]
    async fn restores_high_watermark_from_persisted_entries() {
        let (_dir, file_path) = setup("snapshot.json");
        let store1 = SnapshotStore::new(&file_path);
        store1.mark_pending("a", 5000.0);
        store1.mark_processed("a", None);
        store1.flush().await.unwrap();

        let store2 = SnapshotStore::new(&file_path);
        store2.load().await;
        assert!(store2.get_suggested_since_timestamp() >= 5000.0);
        store2.set_now_ms(5000);
        assert_eq!(store2.get_suggested_since_timestamp(), 5000.0);
    }

    #[tokio::test]
    async fn load_coerces_status_and_ignores_invalid_entries() {
        let (_dir, file_path) = setup("snapshot.json");
        let raw = r#"{
  "highWatermark": 99,
  "entries": [
    null,
    { "timestamp": 1 },
    { "key": "ok", "timestamp": "12", "seenAt": true, "status": "nope", "reason": 5 },
    { "key": "done", "timestamp": 8, "seenAt": "  4 ", "status": "processed", "reason": "kept" }
  ]
}"#;
        tokio::fs::write(&file_path, raw).await.unwrap();
        let store = SnapshotStore::new(&file_path);
        store.load().await;
        assert_eq!(store.size(), 2);
        assert!(!store.should_process("ok"));
        assert!(!store.should_process("done"));
        store.set_now_ms(0);
        // Invalid status stays pending, so it does not raise the watermark.
        // The processed entry's timestamp is 8.
        assert_eq!(store.get_suggested_since_timestamp(), 8.0);
    }

    fn unix_now() -> f64 {
        super::json_file::system_now_ms() as f64
    }
}
