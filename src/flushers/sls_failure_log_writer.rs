//! Port of `src/flushers/sls-failure-log-writer.ts`.
//!
//! Failure files store bounded metadata only. The batch payload is never
//! written. File names are `{safeEndpoint}-{segment}-{localDate}.jsonl`.
//!
//! Filename prefixes preserve NFKC and invalid-character run semantics.
//! The SHA-256 suffix always identifies the original endpoint string.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use super::sls_error_classifier::{redact_sensitive_error_text, truncate_utf8};
use crate::utils::{create_logger, ensure_dir};
use chrono::{DateTime, Local};
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::LazyLock;

const MEBIBYTE: u64 = 1024 * 1024;

pub const SLS_FAILURE_LOG_SCHEMA_VERSION: u32 = 2;
pub const SLS_FAILURE_LOG_MAX_FILE_BYTES: u64 = 10 * MEBIBYTE;
pub const SLS_FAILURE_LOG_MAX_TOTAL_BYTES: u64 = 50 * MEBIBYTE;
pub const SLS_FAILURE_ERROR_SUMMARY_MAX_BYTES: usize = 2 * 1024;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

static ROTATED_FILE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(.*)-(\d+)-(\d{4}-\d{2}-\d{2})\.jsonl$").expect("rotated failure log")
});
static REDACT_BEARER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+").expect("bearer"));
static REDACT_LTAI: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\bLTAI[A-Za-z0-9]{12,}\b").expect("ltai"));
static REDACT_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)((?:access[_-]?key(?:[_-]?(?:id|secret))?|api[_-]?key|authorization)\s*["']?\s*[:=]\s*["']?)[^\s,"'}]+"#,
    )
    .expect("failure key")
});
static REDACT_URL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(https?://)[^\s/@:]+:[^\s/@]+@").expect("failure url"));

#[derive(Clone, Debug)]
pub struct FailureError {
    pub type_name: String,
    pub code: String,
    pub http_status: i64,
    pub summary: String,
}

impl FailureError {
    pub fn from_display(
        type_name: &str,
        summary: impl Into<String>,
        code: &str,
        http_status: i64,
    ) -> Self {
        Self {
            type_name: type_name.to_string(),
            code: code.to_string(),
            http_status,
            summary: summary.into(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct SlsFailureLogInput {
    pub endpoint: String,
    pub mode: String,
    pub project: String,
    pub logstore: String,
    pub kind: String,
    pub batch_count: i64,
    pub batch_bytes: i64,
    pub error: FailureError,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct SlsFailureLogRecord {
    pub schema_version: u32,
    pub ts: i64,
    pub endpoint: String,
    pub mode: String,
    pub project: String,
    pub logstore: String,
    pub kind: String,
    pub error_type: String,
    pub error_code: String,
    pub http_status: i64,
    pub error_summary: String,
    pub batch_count: i64,
    pub batch_bytes: i64,
}

struct FileState {
    date: String,
    segment: u64,
    file_path: PathBuf,
}

struct LogFileInfo {
    file: String,
    full_path: PathBuf,
    size: u64,
    mtime_ms: i64,
    group: Option<String>,
    segment: Option<u64>,
    date: Option<String>,
}

pub struct SlsFailureLogWriter {
    directory: PathBuf,
    max_file_bytes: u64,
    max_total_bytes: u64,
    now: Arc<dyn Fn() -> DateTime<Local> + Send + Sync>,
    states: std::sync::Mutex<std::collections::HashMap<String, FileState>>,
    write_lock: tokio::sync::Mutex<()>,
}

impl SlsFailureLogWriter {
    pub fn new(directory: impl Into<PathBuf>) -> Self {
        Self::with_options(directory, None, None, None)
    }

    pub fn with_options(
        directory: impl Into<PathBuf>,
        max_file_bytes: Option<u64>,
        max_total_bytes: Option<u64>,
        now: Option<Arc<dyn Fn() -> DateTime<Local> + Send + Sync>>,
    ) -> Self {
        Self {
            directory: resolve_dir(directory.into()),
            max_file_bytes: max_file_bytes.unwrap_or(SLS_FAILURE_LOG_MAX_FILE_BYTES),
            max_total_bytes: max_total_bytes.unwrap_or(SLS_FAILURE_LOG_MAX_TOTAL_BYTES),
            now: now.unwrap_or_else(|| Arc::new(Local::now)),
            states: std::sync::Mutex::new(std::collections::HashMap::new()),
            write_lock: tokio::sync::Mutex::new(()),
        }
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }

    pub async fn start(&self) {
        ensure_dir(&self.directory.to_string_lossy()).await;
    }

    pub async fn write(&self, input: &SlsFailureLogInput) -> bool {
        let _guard = self.write_lock.lock().await;
        match self.write_once(input).await {
            Ok(written) => written,
            Err(error) => {
                create_logger("SlsFailureLogWriter").warn(
                    "failed to persist SLS failure metadata",
                    Some(&meta(&[
                        ("endpoint", Value::String(input.endpoint.clone())),
                        ("error", Value::String(error)),
                    ])),
                );
                false
            }
        }
    }

    async fn write_once(&self, input: &SlsFailureLogInput) -> Result<bool, String> {
        ensure_dir(&self.directory.to_string_lossy()).await;
        let now = (self.now)();
        let record = build_sls_failure_log_record(input, now);
        let line = format!(
            "{}\n",
            serde_json::to_string(&record).map_err(|err| err.to_string())?
        );
        let line_bytes = line.len() as u64;
        let safe_endpoint = safe_endpoint_file_prefix(&input.endpoint);
        let state = self.resolve_file_state(&safe_endpoint, &local_date_string(now), line_bytes)?;
        if !is_path_inside(&self.directory, &state.file_path) {
            create_logger("SlsFailureLogWriter").warn(
                "refusing SLS failure log path outside target directory",
                Some(&meta(&[(
                    "endpoint",
                    Value::String(input.endpoint.clone()),
                )])),
            );
            return Ok(false);
        }
        if !self.ensure_capacity(line_bytes, &state.file_path)? {
            create_logger("SlsFailureLogWriter").warn(
                "SLS failure metadata dropped because directory limit is exhausted",
                Some(&meta(&[
                    ("endpoint", Value::String(input.endpoint.clone())),
                    ("maxTotalBytes", Value::from(self.max_total_bytes)),
                ])),
            );
            return Ok(false);
        }
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&state.file_path)
            .and_then(|mut file| {
                use std::io::Write;
                file.write_all(line.as_bytes())
            })
            .map_err(|err| err.to_string())?;
        Ok(true)
    }

    fn resolve_file_state(
        &self,
        safe_endpoint: &str,
        date: &str,
        line_bytes: u64,
    ) -> Result<FileState, String> {
        let key = format!("{safe_endpoint}|{date}");
        let mut states = self.states.lock().unwrap_or_else(|err| err.into_inner());
        let mut state = if let Some(existing) = states.get(&key) {
            FileState {
                date: existing.date.clone(),
                segment: existing.segment,
                file_path: existing.file_path.clone(),
            }
        } else {
            let segment = self.find_latest_segment(safe_endpoint, date);
            FileState {
                date: date.to_string(),
                segment,
                file_path: self.build_file_path(safe_endpoint, segment, date),
            }
        };
        let stat = std::fs::metadata(&state.file_path).ok();
        if let Some(stat) = stat {
            if stat.is_file()
                && stat.len() > 0
                && stat.len().saturating_add(line_bytes) > self.max_file_bytes
            {
                state.segment += 1;
                state.file_path = self.build_file_path(safe_endpoint, state.segment, date);
            }
        }
        states.insert(
            key,
            FileState {
                date: state.date.clone(),
                segment: state.segment,
                file_path: state.file_path.clone(),
            },
        );
        Ok(state)
    }

    fn find_latest_segment(&self, safe_endpoint: &str, date: &str) -> u64 {
        let mut latest = 0_u64;
        let prefix = format!("{safe_endpoint}-");
        let suffix = format!("-{date}.jsonl");
        let Ok(entries) = std::fs::read_dir(&self.directory) else {
            return 0;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !entry
                .file_type()
                .map(|kind| kind.is_file())
                .unwrap_or(false)
            {
                continue;
            }
            if !name.starts_with(&prefix) || !name.ends_with(&suffix) {
                continue;
            }
            let segment_text = &name[prefix.len()..name.len() - suffix.len()];
            if segment_text.is_empty() || !segment_text.bytes().all(|byte| byte.is_ascii_digit()) {
                continue;
            }
            if let Ok(segment) = segment_text.parse::<u64>() {
                latest = latest.max(segment);
            }
        }
        latest
    }

    fn build_file_path(&self, safe_endpoint: &str, segment: u64, date: &str) -> PathBuf {
        self.directory
            .join(format!("{safe_endpoint}-{segment:04}-{date}.jsonl"))
    }

    fn ensure_capacity(&self, incoming_bytes: u64, target_path: &Path) -> Result<bool, String> {
        let mut files = self.collect_log_files();
        let mut total_bytes: u64 = files.iter().map(|file| file.size).sum();
        if total_bytes.saturating_add(incoming_bytes) <= self.max_total_bytes {
            return Ok(true);
        }
        let active = find_active_paths(&files, target_path, &local_date_string((self.now)()));
        let mut candidates: Vec<&LogFileInfo> = files
            .iter()
            .filter(|file| !active.contains(&file.full_path))
            .collect();
        candidates.sort_by(|left, right| {
            left.date
                .cmp(&right.date)
                .then(left.mtime_ms.cmp(&right.mtime_ms))
                .then(left.file.cmp(&right.file))
        });
        for file in candidates {
            if total_bytes.saturating_add(incoming_bytes) <= self.max_total_bytes {
                break;
            }
            match std::fs::remove_file(&file.full_path) {
                Ok(()) => total_bytes = total_bytes.saturating_sub(file.size),
                Err(error) => {
                    create_logger("SlsFailureLogWriter").warn(
                        "failed to remove sealed SLS failure log segment",
                        Some(&meta(&[
                            ("file", Value::String(file.file.clone())),
                            ("error", Value::String(error.to_string())),
                        ])),
                    );
                }
            }
        }
        let _ = &mut files;
        Ok(total_bytes.saturating_add(incoming_bytes) <= self.max_total_bytes)
    }

    fn collect_log_files(&self) -> Vec<LogFileInfo> {
        let mut result = Vec::new();
        let Ok(entries) = std::fs::read_dir(&self.directory) else {
            return result;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".jsonl") {
                continue;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_file() {
                continue;
            }
            let full_path = self.directory.join(&name);
            let Ok(stat) = std::fs::metadata(&full_path) else {
                continue;
            };
            if !stat.is_file() {
                continue;
            }
            let parsed = parse_rotated_file(&name);
            result.push(LogFileInfo {
                file: name,
                full_path,
                size: stat.len(),
                mtime_ms: mtime_ms(&stat.modified().ok()),
                group: parsed.as_ref().map(|item| item.0.clone()),
                segment: parsed.as_ref().map(|item| item.1),
                date: parsed.map(|item| item.2),
            });
        }
        result
    }
}

pub fn build_sls_failure_log_record(
    input: &SlsFailureLogInput,
    now: DateTime<Local>,
) -> SlsFailureLogRecord {
    SlsFailureLogRecord {
        schema_version: SLS_FAILURE_LOG_SCHEMA_VERSION,
        ts: now.timestamp_millis(),
        endpoint: bounded_string(&input.endpoint, 256),
        mode: bounded_string(&input.mode, 64),
        project: bounded_string(&input.project, 256),
        logstore: bounded_string(&input.logstore, 256),
        kind: bounded_string(&input.kind, 128),
        error_type: bounded_string(&input.error.type_name, 128),
        error_code: bounded_string(&input.error.code, 128),
        http_status: input.error.http_status,
        error_summary: truncate_utf8(
            &redact_error_summary(&input.error.summary),
            SLS_FAILURE_ERROR_SUMMARY_MAX_BYTES,
        ),
        batch_count: bounded_non_negative(input.batch_count),
        batch_bytes: bounded_non_negative(input.batch_bytes),
    }
}

pub fn safe_endpoint_file_prefix(endpoint: &str) -> String {
    let normalized = icu_normalizer::ComposingNormalizer::new_nfkc().normalize(endpoint);
    let mut replaced = String::new();
    let mut invalid_run = false;
    for ch in normalized.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
            replaced.push(ch);
            invalid_run = false;
        } else if !invalid_run {
            replaced.push('-');
            invalid_run = true;
        }
    }
    let trimmed = replaced.trim_matches(|ch| matches!(ch, '.' | '_' | '-'));
    let mut base: String = trimmed.chars().take(48).collect();
    if base.is_empty() {
        base = "endpoint".to_string();
    }
    let digest = Sha256::digest(endpoint.as_bytes());
    let hash = hex::encode(digest);
    format!("{base}-{}", &hash[..10])
}

pub fn estimate_string_record_bytes(
    records: &[std::collections::HashMap<String, String>],
) -> usize {
    let mut total = 0_usize;
    for record in records {
        for (key, value) in record {
            total += key.len() + value.len() + 6;
        }
        total += 2;
    }
    total
}

fn redact_error_summary(value: &str) -> String {
    let step = REDACT_BEARER.replace_all(value, "Bearer [REDACTED]");
    let step = REDACT_LTAI.replace_all(&step, "[REDACTED_ACCESS_KEY]");
    let step = REDACT_KEY.replace_all(&step, "$1[REDACTED]");
    let _ = redact_sensitive_error_text;
    REDACT_URL.replace_all(&step, "$1[REDACTED]@").into_owned()
}

fn bounded_string(value: &str, max_bytes: usize) -> String {
    truncate_utf8(value, max_bytes)
}

fn bounded_non_negative(value: i64) -> i64 {
    if value <= 0 {
        0
    } else {
        value.min(MAX_SAFE_INTEGER)
    }
}

fn local_date_string(date: DateTime<Local>) -> String {
    date.format("%Y-%m-%d").to_string()
}

fn is_path_inside(parent: &Path, child: &Path) -> bool {
    let Ok(relative) = child.strip_prefix(parent) else {
        return false;
    };
    !relative.as_os_str().is_empty() && !relative.starts_with("..")
}

fn parse_rotated_file(file: &str) -> Option<(String, u64, String)> {
    let captures = ROTATED_FILE.captures(file)?;
    let group = format!(
        "{}|{}",
        captures.get(1)?.as_str(),
        captures.get(3)?.as_str()
    );
    let segment = captures.get(2)?.as_str().parse().ok()?;
    Some((group, segment, captures.get(3)?.as_str().to_string()))
}

fn find_active_paths(
    files: &[LogFileInfo],
    target_path: &Path,
    today: &str,
) -> std::collections::HashSet<PathBuf> {
    let mut latest_by_group: std::collections::HashMap<String, &LogFileInfo> =
        std::collections::HashMap::new();
    for file in files {
        let (Some(group), Some(segment), Some(date)) = (&file.group, file.segment, &file.date)
        else {
            continue;
        };
        if date != today {
            continue;
        }
        match latest_by_group.get(group) {
            Some(current) if current.segment.unwrap_or(0) >= segment => {}
            _ => {
                latest_by_group.insert(group.clone(), file);
            }
        }
    }
    if let Some((group, _, date)) = parse_rotated_file(
        target_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(""),
    ) {
        if date == today {
            latest_by_group.remove(&group);
        }
    }
    let mut active: std::collections::HashSet<PathBuf> = latest_by_group
        .values()
        .map(|file| file.full_path.clone())
        .collect();
    active.insert(target_path.to_path_buf());
    active
}

fn resolve_dir(directory: PathBuf) -> PathBuf {
    if directory.is_absolute() {
        directory
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(directory)
    }
}

fn mtime_ms(modified: &Option<SystemTime>) -> i64 {
    modified
        .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn meta(pairs: &[(&str, Value)]) -> serde_json::Map<String, Value> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_string(), value.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{DateTime, Local, TimeZone};
    use std::sync::atomic::{AtomicI64, Ordering};
    use std::sync::Arc;

    fn failure_input(error: FailureError) -> SlsFailureLogInput {
        SlsFailureLogInput {
            endpoint: "internal-sls".to_string(),
            mode: "webtracking".to_string(),
            project: "test-project".to_string(),
            logstore: "test-logstore".to_string(),
            kind: "agentActivity".to_string(),
            batch_count: 20,
            batch_bytes: 2048,
            error,
        }
    }

    fn local_at(year: i32, month: u32, day: u32, hour: u32, min: u32, sec: u32) -> DateTime<Local> {
        Local
            .with_ymd_and_hms(year, month, day, hour, min, sec)
            .single()
            .unwrap()
    }

    #[tokio::test]
    async fn writes_versioned_metadata_without_payload_or_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let failed = dir.path().join("logs").join("sls-failed-logs");
        let writer = SlsFailureLogWriter::with_options(
            &failed,
            None,
            None,
            Some(Arc::new(|| local_at(2026, 7, 20, 8, 0, 0))),
        );
        let error = FailureError::from_display(
            "Error",
            "Authorization: Bearer secret-token accessKeySecret=very-secret",
            "ETIMEDOUT",
            503,
        );
        assert!(writer.write(&failure_input(error)).await);
        let mut files: Vec<_> = std::fs::read_dir(&failed)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(files.len(), 1);
        assert!(
            Regex::new(r"^internal-sls-[a-f0-9]{10}-0000-2026-07-20\.jsonl$")
                .unwrap()
                .is_match(&files[0]),
            "filename must independently preserve the ten-hex hash contract"
        );
        let prefix = safe_endpoint_file_prefix("internal-sls");
        assert!(files[0].starts_with(&format!("{prefix}-0000-2026-07-20")));
        let record: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(failed.join(&files[0])).unwrap())
                .unwrap();
        assert_eq!(record["schema_version"], 2);
        assert_eq!(record["endpoint"], "internal-sls");
        assert_eq!(record["mode"], "webtracking");
        assert_eq!(record["error_type"], "Error");
        assert_eq!(record["error_code"], "ETIMEDOUT");
        assert_eq!(record["http_status"], 503);
        assert_eq!(record["batch_count"], 20);
        assert_eq!(record["batch_bytes"], 2048);
        let text = record.to_string();
        assert!(text.contains("[REDACTED]"));
        assert!(!text.contains("secret-token"));
        assert!(!text.contains("very-secret"));
        assert!(record.get("logGroup").is_none());
        assert!(record.get("__logs__").is_none());
        files.sort();
    }

    #[test]
    fn safe_prefix_blocks_path_traversal_and_stays_stable() {
        let prefix = safe_endpoint_file_prefix("../../danger/endpoint");
        assert!(!prefix.contains('/'));
        assert!(!prefix.contains(".."));
        assert_eq!(prefix, safe_endpoint_file_prefix("../../danger/endpoint"));
        assert_ne!(prefix, safe_endpoint_file_prefix("danger-endpoint"));
    }

    #[tokio::test]
    async fn rotates_by_size_and_keeps_every_line_valid_json() {
        let dir = tempfile::tempdir().unwrap();
        let shared = Arc::new(SlsFailureLogWriter::with_options(
            dir.path(),
            Some(650),
            Some(20_000),
            Some(Arc::new(|| local_at(2026, 7, 20, 8, 0, 0))),
        ));
        let mut set = tokio::task::JoinSet::new();
        for index in 0..12 {
            let writer = Arc::clone(&shared);
            set.spawn(async move {
                writer
                    .write(&failure_input(FailureError::from_display(
                        "Error",
                        format!("failure-{index}"),
                        "",
                        0,
                    )))
                    .await
            });
        }
        while let Some(result) = set.join_next().await {
            assert!(result.unwrap());
        }
        let mut files: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        files.sort();
        assert!(files.len() > 1);
        let mut records = Vec::new();
        for file in &files {
            let text = std::fs::read_to_string(file).unwrap();
            for line in text.lines().filter(|line| !line.is_empty()) {
                records.push(serde_json::from_str::<serde_json::Value>(line).unwrap());
            }
        }
        assert_eq!(records.len(), 12);
        assert!(records.iter().all(|record| record["schema_version"] == 2));
    }

    #[tokio::test]
    async fn rotates_when_the_local_date_changes() {
        let dir = tempfile::tempdir().unwrap();
        let day = Arc::new(AtomicI64::new(20));
        let clock_day = Arc::clone(&day);
        let writer = SlsFailureLogWriter::with_options(
            dir.path(),
            None,
            None,
            Some(Arc::new(move || {
                local_at(2026, 7, clock_day.load(Ordering::SeqCst) as u32, 23, 59, 59)
            })),
        );
        assert!(
            writer
                .write(&failure_input(FailureError::from_display(
                    "Error",
                    "network timeout",
                    "",
                    0
                )))
                .await
        );
        day.store(21, Ordering::SeqCst);
        assert!(
            writer
                .write(&failure_input(FailureError::from_display(
                    "Error",
                    "network timeout",
                    "",
                    0
                )))
                .await
        );
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert!(names.iter().any(|name| name.ends_with("-2026-07-20.jsonl")));
        assert!(names.iter().any(|name| name.ends_with("-2026-07-21.jsonl")));
    }

    #[tokio::test]
    async fn enforces_the_directory_total_by_deleting_sealed_segments() {
        let dir = tempfile::tempdir().unwrap();
        let max_total = 1_500_u64;
        let writer = SlsFailureLogWriter::with_options(
            dir.path(),
            Some(500),
            Some(max_total),
            Some(Arc::new(|| local_at(2026, 7, 20, 8, 0, 0))),
        );
        for index in 0..20 {
            let _ = writer
                .write(&failure_input(FailureError::from_display(
                    "Error",
                    format!("bounded-{index}"),
                    "",
                    0,
                )))
                .await;
        }
        let mut total = 0_u64;
        let mut count = 0_usize;
        for entry in std::fs::read_dir(dir.path()).unwrap() {
            let entry = entry.unwrap();
            total += entry.metadata().unwrap().len();
            count += 1;
        }
        assert!(total <= max_total);
        assert!(count > 0);
    }

    #[test]
    fn bounds_error_summaries_by_utf8_bytes() {
        let record = build_sls_failure_log_record(
            &failure_input(FailureError::from_display(
                "Error",
                "错".repeat(4_000),
                "",
                0,
            )),
            local_at(2026, 7, 20, 0, 0, 0),
        );
        assert!(record.error_summary.len() <= SLS_FAILURE_ERROR_SUMMARY_MAX_BYTES);
    }

    #[test]
    fn estimates_string_record_bytes_without_a_batch_envelope() {
        let mut first = std::collections::HashMap::new();
        first.insert("content".to_string(), "abc".to_string());
        let mut second = std::collections::HashMap::new();
        second.insert("content".to_string(), "中文".to_string());
        assert!(estimate_string_record_bytes(&[first, second]) > 9);
        assert_eq!(estimate_string_record_bytes(&[]), 0);
    }
}

#[cfg(test)]
mod migration_unicode_prefix_contracts {
    use super::*;

    #[test]
    fn endpoint_prefix_matches_frozen_typescript_nfkc_and_invalid_run_oracle() {
        let cases: Vec<serde_json::Value> = serde_json::from_str(include_str!(
            "../../tests/fixtures/sls-failure-prefix-cases.json"
        ))
        .unwrap();
        assert_eq!(cases.len(), 15);
        for case in cases {
            let endpoint = case["endpoint"].as_str().unwrap();
            assert_eq!(
                safe_endpoint_file_prefix(endpoint),
                case["prefix"].as_str().unwrap(),
                "original endpoint {endpoint:?}"
            );
        }
    }
}
