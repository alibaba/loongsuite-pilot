//! Dated log cleanup. Port of `log-retention-service.ts`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{Datelike, Duration as ChronoDuration, Local};
use tokio::task::JoinHandle;

use crate::flushers::SLS_FAILURE_LOG_MAX_TOTAL_BYTES;
use crate::types::LogRetentionConfig;
use crate::utils::{parse_output_segment, with_jsonl_file_lock, LOCAL_LOG_EMERGENCY_FILE_BYTES};

use super::{fields, logger};

const DATE_REGEX: &str = r"(\d{4}-\d{2}-\d{2})\.\w+$";
const STARTUP_DELAY_MS: u64 = 30_000;
const MEBIBYTE: u64 = 1024 * 1024;

pub const OUTPUT_RETENTION_MAX_TOTAL_BYTES: u64 = 2 * 1024 * MEBIBYTE;
pub const OUTPUT_RETENTION_LARGE_FILE_THRESHOLD_BYTES: u64 = 512 * MEBIBYTE;
pub const OUTPUT_RETENTION_LARGE_FILE_DAYS: u32 = 2;
pub const OUTPUT_RETENTION_PRESSURE_MIN_KEEP_DAYS: u32 = 1;
pub const SLS_FAILURE_RETENTION_MAX_TOTAL_BYTES: u64 = SLS_FAILURE_LOG_MAX_TOTAL_BYTES;
pub const OTLP_FAILED_RETENTION_MAX_TOTAL_BYTES: u64 = 512 * MEBIBYTE;
pub const METRIC_ALARM_RETENTION_MAX_TOTAL_BYTES: u64 = 256 * MEBIBYTE;
pub const LOCAL_OBSERVABILITY_PRESSURE_MIN_KEEP_DAYS: u32 = 1;

const METRIC_ALARM_STREAMS: &[&str] = &[
    "pilot-metrics",
    "pilot-agent-metrics",
    "pilot-flusher-metrics",
    "pilot-input-metrics",
    "pilot-hook-metrics",
    "pilot-alarm-metrics",
    "pilot-alarms",
    "pilot-updater-events",
];

#[derive(Clone, Copy, PartialEq, Eq)]
enum Category {
    History,
    Errors,
    Debug,
    Output,
    SlsFailed,
    OtlpFailed,
    MetricAlarm,
}

struct DatedLogFile {
    file: String,
    full_path: PathBuf,
    date_str: String,
    size: u64,
    mtime_ms: i64,
}

pub struct LogRetentionService {
    logs_dir: PathBuf,
    config: LogRetentionConfig,
    startup: std::sync::Mutex<Option<JoinHandle<()>>>,
    interval: std::sync::Mutex<Option<JoinHandle<()>>>,
    pressure: std::sync::Mutex<Option<JoinHandle<()>>>,
    cleanup_gate: tokio::sync::Mutex<()>,
}

impl LogRetentionService {
    pub fn new(data_dir: impl AsRef<Path>, config: LogRetentionConfig) -> Self {
        Self {
            logs_dir: data_dir.as_ref().join("logs"),
            config,
            startup: std::sync::Mutex::new(None),
            interval: std::sync::Mutex::new(None),
            pressure: std::sync::Mutex::new(None),
            cleanup_gate: tokio::sync::Mutex::new(()),
        }
    }

    pub fn start(self: &std::sync::Arc<Self>) {
        if !self.config.enabled {
            logger("LogRetention").info("log retention disabled", None);
            return;
        }
        logger("LogRetention").info(
            "scheduling log retention",
            Some(&fields(serde_json::json!({
                "intervalMs": self.config.interval_ms,
                "hookHistoryDays": self.config.hook_history_days,
                "outputDays": self.config.output_days,
                "outputMaxTotalBytes": OUTPUT_RETENTION_MAX_TOTAL_BYTES,
            }))),
        );
        let pressure_service = std::sync::Arc::clone(self);
        *self.pressure.lock().expect("pressure") = Some(tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_secs(60));
            ticker.tick().await;
            loop {
                ticker.tick().await;
                pressure_service.run_pressure_cleanup().await;
            }
        }));
        let this = std::sync::Arc::clone(self);
        *self.startup.lock().expect("startup") = Some(tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(STARTUP_DELAY_MS)).await;
            this.run_cleanup().await;
            let service = std::sync::Arc::clone(&this);
            *this.interval.lock().expect("interval") = Some(tokio::spawn(async move {
                let mut ticker =
                    tokio::time::interval(Duration::from_millis(service.config.interval_ms.max(1)));
                ticker.tick().await;
                loop {
                    ticker.tick().await;
                    service.run_cleanup().await;
                }
            }));
        }));
    }

    pub fn stop(&self) {
        if let Some(task) = self.pressure.lock().expect("pressure").take() {
            task.abort();
        }
        if let Some(task) = self.startup.lock().expect("startup").take() {
            task.abort();
        }
        if let Some(task) = self.interval.lock().expect("interval").take() {
            task.abort();
        }
    }

    pub async fn run_cleanup(&self) -> (u64, u64) {
        self.cleanup(false).await
    }
    pub async fn run_pressure_cleanup(&self) -> (u64, u64) {
        self.cleanup(true).await
    }
    async fn cleanup(&self, pressure_only: bool) -> (u64, u64) {
        let _guard = self.cleanup_gate.lock().await;
        let today = local_date_string(Local::now());
        let mut deleted = 0;
        let mut errors = 0;
        let entries = read_dir(&self.logs_dir);
        for entry in entries {
            let path = self.logs_dir.join(&entry);
            if !ordinary_directory(&path) {
                continue;
            }
            if let Some(category) = category_of(&entry) {
                if pressure_only
                    && !matches!(
                        category,
                        Category::Output
                            | Category::SlsFailed
                            | Category::OtlpFailed
                            | Category::MetricAlarm
                    )
                {
                    continue;
                }
                let (d, e) = self.clean_directory(&path, category, &today).await;
                deleted += d;
                errors += e;
            } else {
                for sub in read_dir(&path) {
                    let Some(category) = category_of(&sub) else {
                        continue;
                    };
                    if pressure_only
                        && !matches!(
                            category,
                            Category::Output
                                | Category::SlsFailed
                                | Category::OtlpFailed
                                | Category::MetricAlarm
                        )
                    {
                        continue;
                    }
                    let sub_path = path.join(&sub);
                    if !ordinary_directory(&sub_path) {
                        continue;
                    }
                    let (d, e) = self.clean_directory(&sub_path, category, &today).await;
                    deleted += d;
                    errors += e;
                }
            }
        }
        if deleted > 0 || errors > 0 {
            logger("LogRetention").info(
                "log retention complete",
                Some(&fields(
                    serde_json::json!({ "deleted": deleted, "errors": errors }),
                )),
            );
        }
        (deleted, errors)
    }

    async fn clean_directory(&self, dir: &Path, category: Category, today: &str) -> (u64, u64) {
        let files = read_dir(dir);
        match category {
            Category::Output => self.clean_output(dir, &files, today).await,
            Category::SlsFailed => self.clean_sls_failed(dir, &files, today).await,
            Category::OtlpFailed | Category::MetricAlarm => {
                self.clean_observability(dir, &files, category).await
            }
            _ => {
                let cutoff = date_cutoff(self.retention_days(category));
                let mut deleted = 0;
                let mut errors = 0;
                for file in files {
                    let Some(date) = extract_date(&file) else {
                        continue;
                    };
                    if date == today || date >= cutoff {
                        continue;
                    }
                    if delete_file(&dir.join(&file)).await {
                        deleted += 1;
                    } else {
                        errors += 1;
                    }
                }
                (deleted, errors)
            }
        }
    }

    async fn clean_output(&self, dir: &Path, files: &[String], today: &str) -> (u64, u64) {
        let mut deleted = 0;
        let mut errors = 0;
        let mut remaining = collect_output_dated(dir, files);
        let (d, e) = reclaim_oversized_files(&remaining, false).await;
        deleted += d;
        errors += e;
        remaining = collect_output_dated(dir, &read_dir(dir));
        let regular = date_cutoff(self.config.output_days);
        let (d, e, attempted) = delete_matching(&remaining, |file| {
            file.date_str != today && file.date_str < regular
        })
        .await;
        deleted += d;
        errors += e;
        remaining.retain(|file| !attempted.contains(&file.full_path));
        let large_cutoff = date_cutoff(OUTPUT_RETENTION_LARGE_FILE_DAYS);
        let (d, e, attempted) = delete_matching(&remaining, |file| {
            file.date_str != today
                && file.date_str < large_cutoff
                && file.size > OUTPUT_RETENTION_LARGE_FILE_THRESHOLD_BYTES
        })
        .await;
        deleted += d;
        errors += e;
        remaining.retain(|file| !attempted.contains(&file.full_path));
        let (d, e) = enforce_output_limit(&remaining, today).await;
        (deleted + d, errors + e)
    }

    async fn clean_sls_failed(&self, dir: &Path, files: &[String], today: &str) -> (u64, u64) {
        let mut deleted = 0;
        let mut errors = 0;
        let mut remaining = collect_dated(dir, files);
        let (d, e) = reclaim_oversized_files(&remaining, true).await;
        deleted += d;
        errors += e;
        remaining = collect_dated(dir, &read_dir(dir));
        let cutoff = date_cutoff(self.config.sls_failed_days);
        let (d, e, _) = delete_matching(&remaining, |file| {
            file.date_str != today && file.date_str < cutoff
        })
        .await;
        deleted += d;
        errors += e;
        remaining = collect_dated(dir, &read_dir(dir));
        let mut total: u64 = remaining.iter().map(|file| file.size).sum();
        if total <= SLS_FAILURE_RETENTION_MAX_TOTAL_BYTES {
            return (deleted, errors);
        }
        let active = active_sls_segments(&remaining, today);
        let mut candidates: Vec<&DatedLogFile> = remaining
            .iter()
            .filter(|file| !active.contains(&file.full_path))
            .collect();
        candidates.sort_by(|left, right| {
            left.date_str
                .cmp(&right.date_str)
                .then(left.file.cmp(&right.file))
        });
        for file in candidates {
            if total <= SLS_FAILURE_RETENTION_MAX_TOTAL_BYTES {
                break;
            }
            if delete_file(&file.full_path).await {
                deleted += 1;
                total = total.saturating_sub(file.size);
            } else {
                errors += 1;
            }
        }
        (deleted, errors)
    }

    async fn clean_observability(
        &self,
        dir: &Path,
        files: &[String],
        category: Category,
    ) -> (u64, u64) {
        let mut deleted = 0;
        let mut errors = 0;
        let mut remaining = collect_observability(dir, files, category);
        let (d, e) = reclaim_oversized_files(&remaining, category == Category::OtlpFailed).await;
        deleted += d;
        errors += e;
        remaining = collect_observability(dir, &read_dir(dir), category);
        let retention_cutoff = date_cutoff(self.retention_days(category));
        let protected_from = date_cutoff(LOCAL_OBSERVABILITY_PRESSURE_MIN_KEEP_DAYS);
        let (d, e, _) = delete_matching(&remaining, |file| {
            file.date_str < protected_from && file.date_str < retention_cutoff
        })
        .await;
        deleted += d;
        errors += e;
        remaining = collect_observability(dir, &read_dir(dir), category);
        let mut total: u64 = remaining.iter().map(|file| file.size).sum();
        let max_total = if category == Category::OtlpFailed {
            OTLP_FAILED_RETENTION_MAX_TOTAL_BYTES
        } else {
            METRIC_ALARM_RETENTION_MAX_TOTAL_BYTES
        };
        if total <= max_total {
            return (deleted, errors);
        }
        let mut candidates: Vec<&DatedLogFile> = remaining
            .iter()
            .filter(|file| {
                parse_output_segment(&file.file).is_some() || file.date_str < protected_from
            })
            .collect();
        candidates.sort_by(|left, right| {
            left.date_str
                .cmp(&right.date_str)
                .then(left.mtime_ms.cmp(&right.mtime_ms))
                .then(left.file.cmp(&right.file))
        });
        for file in candidates {
            if total <= max_total {
                break;
            }
            if delete_file(&file.full_path).await {
                deleted += 1;
                total = total.saturating_sub(file.size);
            } else {
                errors += 1;
            }
        }
        (deleted, errors)
    }

    fn retention_days(&self, category: Category) -> u32 {
        match category {
            Category::History => self.config.hook_history_days,
            Category::Errors => self.config.hook_error_days,
            Category::Debug => self.config.hook_debug_days,
            Category::Output => self.config.output_days,
            Category::SlsFailed => self.config.sls_failed_days,
            Category::OtlpFailed => self.config.otlp_failed_days,
            Category::MetricAlarm => self.config.metric_alarm_days,
        }
    }
}

pub fn extract_date(filename: &str) -> Option<String> {
    let regex = regex::Regex::new(DATE_REGEX).ok()?;
    let date = regex.captures(filename)?.get(1)?.as_str();
    let mut parts = date.split('-');
    let year: i32 = parts.next()?.parse().ok()?;
    let month: u32 = parts.next()?.parse().ok()?;
    let day: u32 = parts.next()?.parse().ok()?;
    if (2020..=2099).contains(&year) && (1..=12).contains(&month) && (1..=31).contains(&day) {
        Some(date.to_string())
    } else {
        None
    }
}

fn category_of(name: &str) -> Option<Category> {
    match name {
        "history" => Some(Category::History),
        "errors" => Some(Category::Errors),
        "debug" => Some(Category::Debug),
        "output" | "otlp-debug" => Some(Category::Output),
        "sls-failed-logs" => Some(Category::SlsFailed),
        "otlp-failed" => Some(Category::OtlpFailed),
        "metric_alarm" => Some(Category::MetricAlarm),
        _ => None,
    }
}

fn date_cutoff(days: u32) -> String {
    calendar_date_cutoff(Local::now().date_naive(), days)
}

fn calendar_date_cutoff(date: chrono::NaiveDate, days: u32) -> String {
    (date - ChronoDuration::days(i64::from(days)))
        .format("%Y-%m-%d")
        .to_string()
}

fn local_date_string(date: chrono::DateTime<Local>) -> String {
    format!("{:04}-{:02}-{:02}", date.year(), date.month(), date.day())
}

fn read_dir(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir)
        .ok()
        .map(|entries| {
            entries
                .filter_map(|entry| {
                    entry
                        .ok()
                        .and_then(|entry| entry.file_name().into_string().ok())
                })
                .collect()
        })
        .unwrap_or_default()
}

fn ordinary_directory(path: &Path) -> bool {
    crate::utils::runtime_paths::runtime_metadata(path).is_ok_and(|meta| meta.is_dir())
}

fn collect_output_dated(dir: &Path, files: &[String]) -> Vec<DatedLogFile> {
    files
        .iter()
        .filter_map(|file| {
            let full_path = dir.join(file);
            let metadata = crate::utils::runtime_paths::runtime_metadata(&full_path).ok()?;
            if !metadata.is_file() {
                return None;
            }
            let date = extract_date(file).or_else(|| {
                if parse_output_segment(file).is_some_and(|segment| segment.date == "all") {
                    metadata
                        .modified()
                        .ok()
                        .map(|time| local_date_string(chrono::DateTime::<Local>::from(time)))
                } else if file.ends_with("-all.jsonl") {
                    Some(local_date_string(Local::now()))
                } else {
                    None
                }
            })?;
            Some(DatedLogFile {
                file: file.clone(),
                full_path,
                date_str: date,
                size: metadata.len(),
                mtime_ms: mtime_ms(&metadata),
            })
        })
        .collect()
}

async fn reclaim_oversized_files(files: &[DatedLogFile], failed_data: bool) -> (u64, u64) {
    let mut deleted = 0;
    let mut errors = 0;
    for file in files {
        if file.size <= LOCAL_LOG_EMERGENCY_FILE_BYTES {
            continue;
        }
        let outcome = with_jsonl_file_lock(&file.full_path, || async {
            let metadata = match tokio::fs::symlink_metadata(&file.full_path).await {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
                Err(error) => return Err(error),
            };
            if !metadata.is_file() || metadata.len() <= LOCAL_LOG_EMERGENCY_FILE_BYTES {
                return Ok(false);
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if metadata.file_attributes() & 0x400 != 0 {
                    return Ok(false);
                }
            }
            tokio::fs::remove_file(&file.full_path).await?;
            logger("LogRetention").warn(
                "Deleted oversized local JSONL file",
                Some(&fields(
                    serde_json::json!({"bytes":metadata.len(),"discardedFailedData":failed_data}),
                )),
            );
            Ok::<_, std::io::Error>(true)
        })
        .await;
        match outcome {
            Ok(true) => deleted += 1,
            Ok(false) => {}
            Err(_) => errors += 1,
        }
    }
    (deleted, errors)
}

fn collect_dated(dir: &Path, files: &[String]) -> Vec<DatedLogFile> {
    files
        .iter()
        .filter_map(|file| {
            let date = extract_date(file)?;
            let full_path = dir.join(file);
            let meta = std::fs::symlink_metadata(&full_path).ok()?;
            if !meta.is_file() {
                return None;
            }
            Some(DatedLogFile {
                file: file.clone(),
                date_str: date,
                size: meta.len(),
                mtime_ms: mtime_ms(&meta),
                full_path,
            })
        })
        .collect()
}

fn collect_observability(dir: &Path, files: &[String], category: Category) -> Vec<DatedLogFile> {
    files
        .iter()
        .filter_map(|file| {
            if file.starts_with('.') || !file.ends_with(".jsonl") {
                return None;
            }
            let extracted = extract_date(file);
            let dated = extracted
                .as_ref()
                .is_some_and(|date| managed_dated(file, date, category));
            let legacy = extracted.is_none() && managed_legacy(file, category);
            if !dated && !legacy {
                return None;
            }
            let full_path = dir.join(file);
            let meta = std::fs::symlink_metadata(&full_path).ok()?;
            if !meta.is_file() {
                return None;
            }
            let date_str = extracted.unwrap_or_else(|| {
                meta.modified()
                    .map(|modified| local_date_string(modified.into()))
                    .unwrap_or_else(|_| local_date_string(Local::now()))
            });
            Some(DatedLogFile {
                file: file.clone(),
                date_str,
                size: meta.len(),
                mtime_ms: mtime_ms(&meta),
                full_path,
            })
        })
        .collect()
}

fn managed_dated(file: &str, date: &str, category: Category) -> bool {
    if category == Category::OtlpFailed {
        return true;
    }
    let suffix = format!("-{date}.jsonl");
    file.ends_with(&suffix)
        && METRIC_ALARM_STREAMS.contains(&file[..file.len() - suffix.len()].as_ref())
}

fn managed_legacy(file: &str, category: Category) -> bool {
    if category == Category::OtlpFailed {
        return true;
    }
    file.strip_suffix(".jsonl")
        .is_some_and(|name| METRIC_ALARM_STREAMS.contains(&name))
}

async fn delete_matching(
    files: &[DatedLogFile],
    mut should: impl FnMut(&DatedLogFile) -> bool,
) -> (u64, u64, HashSet<PathBuf>) {
    let mut deleted = 0;
    let mut errors = 0;
    let mut attempted = HashSet::new();
    for file in files {
        if !should(file) {
            continue;
        }
        attempted.insert(file.full_path.clone());
        if delete_file(&file.full_path).await {
            deleted += 1;
        } else {
            errors += 1;
        }
    }
    (deleted, errors, attempted)
}

async fn enforce_output_limit(files: &[DatedLogFile], today: &str) -> (u64, u64) {
    let mut total: u64 = files.iter().map(|file| file.size).sum();
    if total <= OUTPUT_RETENTION_MAX_TOTAL_BYTES {
        return (0, 0);
    }
    let min_keep = date_cutoff(OUTPUT_RETENTION_PRESSURE_MIN_KEEP_DAYS);
    let mut candidates: Vec<&DatedLogFile> = files
        .iter()
        .filter(|file| {
            parse_output_segment(&file.file).is_some()
                || (file.date_str != today && file.date_str < min_keep)
        })
        .collect();
    candidates.sort_by(|left, right| {
        left.date_str
            .cmp(&right.date_str)
            .then(left.mtime_ms.cmp(&right.mtime_ms))
            .then(left.file.cmp(&right.file))
    });
    let mut deleted = 0;
    let mut errors = 0;
    for file in candidates {
        if total <= OUTPUT_RETENTION_MAX_TOTAL_BYTES {
            break;
        }
        if delete_file(&file.full_path).await {
            deleted += 1;
            total = total.saturating_sub(file.size);
        } else {
            errors += 1;
        }
    }
    (deleted, errors)
}

fn active_sls_segments(files: &[DatedLogFile], today: &str) -> HashSet<PathBuf> {
    let mut latest: HashMap<String, (u64, PathBuf)> = HashMap::new();
    let pattern = regex::Regex::new(r"^(.*)-(\d+)-(\d{4}-\d{2}-\d{2})\.jsonl$").expect("segment");
    for file in files {
        if file.date_str != today {
            continue;
        }
        let Some(caps) = pattern.captures(&file.file) else {
            continue;
        };
        if caps.get(3).map(|item| item.as_str()) != Some(today) {
            continue;
        }
        let segment: u64 = caps
            .get(2)
            .and_then(|item| item.as_str().parse().ok())
            .unwrap_or(0);
        let endpoint = caps
            .get(1)
            .map(|item| item.as_str().to_string())
            .unwrap_or_default();
        let replace = latest
            .get(&endpoint)
            .map(|(current, _)| segment > *current)
            .unwrap_or(true);
        if replace {
            latest.insert(endpoint, (segment, file.full_path.clone()));
        }
    }
    latest.into_values().map(|(_, path)| path).collect()
}

async fn delete_file(path: &Path) -> bool {
    with_jsonl_file_lock(path, || async {
        match tokio::fs::remove_file(path).await {
            Ok(()) => true,
            Err(error) => {
                logger("LogRetention").warn("failed to delete log file",
                    Some(&fields(serde_json::json!({"file":path.display().to_string(),"error":error.to_string()}))));
                false
            }
        }
    }).await
}

fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(days: u32) -> LogRetentionConfig {
        LogRetentionConfig {
            enabled: true,
            interval_ms: 1,
            hook_history_days: days,
            hook_error_days: days,
            hook_debug_days: days,
            output_days: days,
            sls_failed_days: days,
            otlp_failed_days: days,
            metric_alarm_days: days,
        }
    }

    #[test]
    fn extract_date_accepts_a_real_suffix_and_rejects_junk() {
        assert_eq!(
            extract_date("events-2024-03-09.jsonl").as_deref(),
            Some("2024-03-09")
        );
        assert!(extract_date("events-2019-01-01.jsonl").is_none());
        assert!(extract_date("no-date.jsonl").is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pressure_reclaims_today_sealed_segments_but_preserves_the_active_file() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("logs/output");
        std::fs::create_dir_all(&output).unwrap();
        let today = local_date_string(Local::now());
        let active = output.join(format!("copilot-{today}.jsonl"));
        std::fs::write(&active, b"active\n").unwrap();
        for index in 0..3 {
            let path = output.join(format!("copilot.part-{index:032x}-{today}.jsonl"));
            std::fs::File::create(path)
                .unwrap()
                .set_len(900 * 1024 * 1024)
                .unwrap();
        }
        let service = LogRetentionService::new(dir.path(), config(7));
        let (deleted, errors) = service.run_pressure_cleanup().await;
        assert_eq!((deleted, errors), (1, 0));
        assert_eq!(std::fs::read_to_string(&active).unwrap(), "active\n");
        let bytes: u64 = std::fs::read_dir(output)
            .unwrap()
            .map(|entry| entry.unwrap().metadata().unwrap().len())
            .sum();
        assert!(bytes <= super::OUTPUT_RETENTION_MAX_TOTAL_BYTES);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn emergency_reclaims_managed_mirrors_and_failed_evidence_without_touching_sources_or_checkpoints(
    ) {
        let dir = tempfile::tempdir().unwrap();
        let today = local_date_string(Local::now());
        let giant = crate::utils::LOCAL_LOG_EMERGENCY_FILE_BYTES + 1;
        let sparse = |path: std::path::PathBuf| {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::File::create(path).unwrap().set_len(giant).unwrap();
        };
        let output = dir
            .path()
            .join(format!("logs/output/copilot-{today}.jsonl"));
        let failed = dir.path().join(format!(
            "logs/otlp-failed/service-copilot__backend-{today}.jsonl"
        ));
        let debug = dir
            .path()
            .join(format!("logs/otlp-debug/service-copilot-{today}.jsonl"));
        let native = dir.path().join("agent-home/events.jsonl");
        let pending = dir
            .path()
            .join("logs/codex-pending-turns/group.pending.jsonl");
        let doubao_pending = dir
            .path()
            .join("logs/doubao-pending-turns/group.pending.jsonl");
        for path in [&output, &failed, &debug, &native, &pending, &doubao_pending] {
            sparse(path.clone());
        }
        let checkpoint = dir.path().join("logs/input-state.json");
        std::fs::write(&checkpoint, b"{\"cursor\":42}").unwrap();
        let (deleted, errors) = LogRetentionService::new(dir.path(), config(7))
            .run_pressure_cleanup()
            .await;
        assert_eq!((deleted, errors), (3, 0));
        assert!(!output.exists() && !failed.exists() && !debug.exists());
        assert_eq!(std::fs::metadata(native).unwrap().len(), giant);
        assert_eq!(std::fs::metadata(pending).unwrap().len(), giant);
        assert_eq!(std::fs::metadata(doubao_pending).unwrap().len(), giant);
        assert_eq!(
            std::fs::read_to_string(checkpoint).unwrap(),
            "{\"cursor\":42}"
        );
    }

    #[tokio::test]
    async fn deletes_output_files_older_than_the_retention_window() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("logs").join("output");
        std::fs::create_dir_all(&output).unwrap();
        std::fs::write(output.join("events-2020-01-02.jsonl"), b"old").unwrap();
        std::fs::write(
            output.join(format!("events-{}.jsonl", local_date_string(Local::now()))),
            b"today",
        )
        .unwrap();
        let service = LogRetentionService::new(dir.path(), config(7));
        let (deleted, errors) = service.run_cleanup().await;
        assert_eq!(errors, 0);
        assert_eq!(deleted, 1);
        assert!(!output.join("events-2020-01-02.jsonl").exists());
        assert!(output
            .join(format!("events-{}.jsonl", local_date_string(Local::now())))
            .exists());
    }

    #[tokio::test]
    async fn hook_metric_mirror_obeys_metric_alarm_retention() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs/metric_alarm");
        std::fs::create_dir_all(&logs).unwrap();
        let old = logs.join("pilot-hook-metrics-2020-01-02.jsonl");
        let today = logs.join(format!(
            "pilot-hook-metrics-{}.jsonl",
            local_date_string(Local::now())
        ));
        let unrelated = logs.join("user-hook-metrics-2020-01-02.jsonl");
        for path in [&old, &today, &unrelated] {
            std::fs::write(path, b"fixture").unwrap();
        }
        let (deleted, errors) = LogRetentionService::new(dir.path(), config(7))
            .run_cleanup()
            .await;
        assert_eq!((deleted, errors), (1, 0));
        assert!(!old.exists());
        assert!(today.exists() && unrelated.exists());
    }
}

#[cfg(test)]
#[path = "log_retention_history_tests.rs"]
mod history_tests;
