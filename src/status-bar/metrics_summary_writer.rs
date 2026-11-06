//! Port of `src/status-bar/metrics-summary-writer.ts`.
//!
//! `logs/metrics-summary.json` is the contract shared by the menu bar, the
//! dashboard, and `token-usage`. Field names stay camelCase.

use super::jsonl_tail_reader::{scan_jsonl_tail, scan_jsonl_tail_checked};
use crate::types::StatusBarConfig;
use crate::utils::file_identity::{identity_from_open, OpenedFileIdentity as FileIdentity};
use crate::utils::LOCAL_LOG_EMERGENCY_FILE_BYTES;
use crate::utils::{ensure_dir, get_today_date_string, read_json_file, write_json_file};
use chrono::{Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const DIGEST_MAX_DAYS: i64 = 200;
const FILE_NAME_PATTERN: &str = r"^(.+)-(\d{4}-\d{2}-\d{2})\.jsonl$";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelShareEntry {
    pub model: String,
    pub total_tokens: f64,
    pub input_tokens: f64,
    pub cache_read_tokens: f64,
    pub share: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentShareEntry {
    pub agent_type: String,
    pub sessions: u64,
    pub events: u64,
    pub tokens: f64,
    pub share: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderShareEntry {
    pub provider: String,
    pub total_tokens: f64,
    pub share: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoShareEntry {
    pub repo: String,
    pub sessions: u64,
    pub events: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MetricsSummaryRangeData {
    pub total_tokens: f64,
    pub input_tokens: f64,
    pub output_tokens: f64,
    pub cache_read_tokens: f64,
    pub cache_creation_tokens: f64,
    pub total_sessions: u64,
    pub total_requests: u64,
    pub total_tool_calls: u64,
    pub total_events: u64,
    pub model_shares: Vec<ModelShareEntry>,
    pub agent_shares: Vec<AgentShareEntry>,
    pub provider_shares: Vec<ProviderShareEntry>,
    pub repo_shares: Vec<RepoShareEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DailyPoint {
    pub day: String,
    pub value: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MetricsSummary {
    pub version: u32,
    pub generated_at: String,
    pub package_version: String,
    pub ranges: MetricsRanges,
    pub daily_tokens: Vec<DailyPoint>,
    pub daily_sessions: Vec<DailyPoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MetricsRanges {
    pub today: MetricsSummaryRangeData,
    pub seven_days: MetricsSummaryRangeData,
    pub thirty_days: MetricsSummaryRangeData,
}

#[derive(Clone, Debug)]
struct ModelTokens {
    total: f64,
    input: f64,
    cache_read: f64,
}

#[derive(Clone, Debug)]
struct AgentStats {
    sessions: BTreeSet<String>,
    events: u64,
    tokens: f64,
}

#[derive(Clone, Debug)]
struct RepoStats {
    sessions: BTreeSet<String>,
    events: u64,
}

#[derive(Clone, Debug, Default)]
struct DayStats {
    tokens: f64,
    input_tokens: f64,
    output_tokens: f64,
    cache_read_tokens: f64,
    cache_creation_tokens: f64,
    sessions: BTreeSet<String>,
    requests: u64,
    tool_calls: u64,
    events: u64,
    model_tokens: BTreeMap<String, ModelTokens>,
    agent_stats: BTreeMap<String, AgentStats>,
    provider_tokens: BTreeMap<String, f64>,
    repo_stats: BTreeMap<String, RepoStats>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DayDigest {
    tokens: f64,
    input_tokens: f64,
    output_tokens: f64,
    cache_read_tokens: f64,
    cache_creation_tokens: f64,
    sessions: u64,
    requests: u64,
    tool_calls: u64,
    events: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct DigestFile {
    version: u32,
    days: HashMap<String, DayDigest>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ScanFile {
    offset: u64,
    size: u64,
    ino: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
struct ScanState {
    files: HashMap<String, ScanFile>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SerializedDayStats {
    tokens: f64,
    input_tokens: f64,
    output_tokens: f64,
    cache_read_tokens: f64,
    cache_creation_tokens: f64,
    sessions: Vec<String>,
    requests: u64,
    tool_calls: u64,
    events: u64,
    model_tokens: Vec<(String, ModelTokenFile)>,
    agent_stats: Vec<(String, AgentStatFile)>,
    provider_tokens: Vec<(String, f64)>,
    repo_stats: Vec<(String, RepoStatFile)>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ModelTokenFile {
    total: f64,
    input: f64,
    #[serde(rename = "cacheRead")]
    cache_read: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct AgentStatFile {
    sessions: Vec<String>,
    events: u64,
    tokens: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct RepoStatFile {
    sessions: Vec<String>,
    events: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CurrentDayFileState {
    file_name: String,
    dev: u64,
    ino: u64,
    birthtime_ms: f64,
    offset: u64,
    size: u64,
    stats: SerializedDayStats,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct CurrentDayState {
    version: u32,
    day: String,
    files: Vec<CurrentDayFileState>,
}

#[cfg(test)]
type BeforeCurrentScan = std::sync::Arc<dyn Fn(&str) + Send + Sync>;

pub struct MetricsSummaryWriter {
    data_dir: String,
    output_dir: String,
    summary_path: String,
    digest_path: String,
    scan_state_path: String,
    current_day_state_path: String,
    stopped: Mutex<bool>,
    refresh_lock: tokio::sync::Mutex<()>,
    scan_bytes: Mutex<Vec<u64>>,
    #[cfg(test)]
    before_current_scan: Mutex<Option<BeforeCurrentScan>>,
}

impl MetricsSummaryWriter {
    pub fn new(data_dir: &str, _config: StatusBarConfig, output_dir: Option<&str>) -> Self {
        let output = output_dir.map(str::to_string).unwrap_or_else(|| {
            Path::new(data_dir)
                .join("logs")
                .join("output")
                .to_string_lossy()
                .into_owned()
        });
        Self {
            summary_path: Path::new(data_dir)
                .join("logs")
                .join("metrics-summary.json")
                .to_string_lossy()
                .into_owned(),
            digest_path: Path::new(data_dir)
                .join("cache")
                .join("metrics-daily-digest.json")
                .to_string_lossy()
                .into_owned(),
            scan_state_path: Path::new(data_dir)
                .join("cache")
                .join("metrics-scan-state.json")
                .to_string_lossy()
                .into_owned(),
            current_day_state_path: Path::new(data_dir)
                .join("cache")
                .join("metrics-current-day-state.json")
                .to_string_lossy()
                .into_owned(),
            data_dir: data_dir.to_string(),
            output_dir: output,
            stopped: Mutex::new(false),
            refresh_lock: tokio::sync::Mutex::new(()),
            scan_bytes: Mutex::new(Vec::new()),
            #[cfg(test)]
            before_current_scan: Mutex::new(None),
        }
    }

    pub fn summary_path(&self) -> &str {
        &self.summary_path
    }

    pub fn current_day_scan_bytes(&self) -> Vec<u64> {
        self.scan_bytes
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone()
    }

    pub async fn stop(&self) {
        *self.stopped.lock().unwrap_or_else(|err| err.into_inner()) = true;
        let _guard = self.refresh_lock.lock().await;
    }

    pub async fn refresh(&self) {
        if *self.stopped.lock().unwrap_or_else(|err| err.into_inner()) {
            return;
        }
        let _guard = self.refresh_lock.lock().await;
        if *self.stopped.lock().unwrap_or_else(|err| err.into_inner()) {
            return;
        }
        if let Err(error) = self.aggregate().await {
            let details = serde_json::json!({"error": format!("Error: {error}")});
            crate::utils::create_logger("MetricsSummaryWriter")
                .warn("metrics summary refresh failed", details.as_object());
        }
    }

    async fn aggregate(&self) -> Result<(), String> {
        let today = get_today_date_string();
        let mut scan_state = self.load_scan_state().await;
        let mut digest = self.load_digest().await;
        let files = self.list_output_files().await;
        let mut current_day_state = self.load_current_day_state().await;
        if let Some(state) = current_day_state.clone() {
            if state.day != today {
                let refreshed = self.refresh_current_day_state(state, &files).await?;
                let completed = merge_current_day_stats(&refreshed);
                digest
                    .days
                    .insert(refreshed.day.clone(), day_stats_to_digest(&completed, None));
                copy_offsets(&refreshed, &mut scan_state);
                current_day_state = None;
            }
        }
        let mut live_stats: HashMap<String, DayStats> = HashMap::new();
        let mut full_scan_days = BTreeSet::new();
        let pattern = regex::Regex::new(FILE_NAME_PATTERN).map_err(|err| err.to_string())?;
        for file in &files {
            let Some(name) = Path::new(file).file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            let Some(caps) = pattern.captures(name) else {
                continue;
            };
            let day = caps.get(2).unwrap().as_str();
            if day == today {
                continue;
            }
            let Some(identity) = file_identity(Path::new(file)) else {
                continue;
            };
            if identity.size > LOCAL_LOG_EMERGENCY_FILE_BYTES {
                crate::utils::create_logger("MetricsSummaryWriter").warn("metrics summary skipped oversized output file",
                    Some(&serde_json::json!({"bytes":identity.size,"maxBytes":LOCAL_LOG_EMERGENCY_FILE_BYTES}).as_object().cloned().unwrap_or_default()));
                continue;
            }
            let has_digest = digest.days.contains_key(day);
            let cached = scan_state.files.get(name);
            let mut start_offset = 0_u64;
            if has_digest {
                if let Some(cached) = cached {
                    if cached.ino == identity.ino && cached.size <= identity.size {
                        start_offset = cached.offset;
                    }
                }
            }
            if start_offset >= identity.size && has_digest {
                live_stats.entry(day.to_string()).or_default();
                continue;
            }
            if start_offset == 0 {
                full_scan_days.insert(day.to_string());
            }
            let stats = live_stats.entry(day.to_string()).or_default();
            let new_offset = scan_file(file, start_offset, identity.size, stats).await?;
            scan_state.files.insert(
                name.to_string(),
                ScanFile {
                    offset: new_offset,
                    size: identity.size,
                    ino: identity.ino,
                },
            );
        }
        for (day, stats) in &live_stats {
            if day == &today {
                continue;
            }
            let existing = digest.days.get(day);
            if existing.is_none() || stats.events > 0 {
                let digest_entry = if full_scan_days.contains(day) {
                    day_stats_to_digest(stats, None)
                } else {
                    day_stats_to_digest(stats, existing)
                };
                digest.days.insert(day.clone(), digest_entry);
            }
        }
        let mut current = current_day_state.unwrap_or(CurrentDayState {
            version: 1,
            day: today.clone(),
            files: Vec::new(),
        });
        current = self.refresh_current_day_state(current, &files).await?;
        let today_live = merge_current_day_stats(&current);
        prune_digest(&mut digest, &today);
        let summary = build_summary(
            &digest,
            &today_live,
            &today,
            &read_package_version(&self.data_dir),
        );
        if let Some(parent) = Path::new(&self.digest_path).parent() {
            ensure_dir(&parent.to_string_lossy()).await;
        }
        if let Some(parent) = Path::new(&self.summary_path).parent() {
            ensure_dir(&parent.to_string_lossy()).await;
        }
        write_json_file(&self.digest_path, &digest)
            .await
            .map_err(|err| err.to_string())?;
        write_json_file(&self.scan_state_path, &scan_state)
            .await
            .map_err(|err| err.to_string())?;
        write_json_file(&self.current_day_state_path, &current)
            .await
            .map_err(|err| err.to_string())?;
        write_json_file(&self.summary_path, &summary)
            .await
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    async fn refresh_current_day_state(
        &self,
        state: CurrentDayState,
        files: &[String],
    ) -> Result<CurrentDayState, String> {
        let pattern = regex::Regex::new(FILE_NAME_PATTERN).map_err(|err| err.to_string())?;
        let existing: HashMap<String, CurrentDayFileState> = state
            .files
            .iter()
            .map(|file| {
                (
                    identity_key(file.dev, file.ino, file.birthtime_ms),
                    file.clone(),
                )
            })
            .collect();
        let mut next = existing.clone();
        let mut total_bytes = 0_u64;
        for file_path in files {
            let Some(name) = Path::new(file_path)
                .file_name()
                .and_then(|value| value.to_str())
            else {
                continue;
            };
            let Some(caps) = pattern.captures(name) else {
                continue;
            };
            if caps.get(2).unwrap().as_str() != state.day {
                continue;
            }
            let Some(identity) = file_identity(Path::new(file_path)) else {
                continue;
            };
            if identity.size > LOCAL_LOG_EMERGENCY_FILE_BYTES {
                crate::utils::create_logger("MetricsSummaryWriter").warn("metrics summary skipped oversized output file",
                    Some(&serde_json::json!({"bytes":identity.size,"maxBytes":LOCAL_LOG_EMERGENCY_FILE_BYTES}).as_object().cloned().unwrap_or_default()));
                continue;
            }
            let key = identity_key(identity.dev, identity.ino, identity.birthtime_ms);
            let previous = existing.get(&key);
            for (old_key, old) in &mut next {
                if old_key != &key && old.file_name == name {
                    old.file_name = format!("retired:{old_key}");
                }
            }
            let can_resume = previous.is_some_and(|file| {
                file.dev == identity.dev
                    && file.ino == identity.ino
                    && file.birthtime_ms == identity.birthtime_ms
                    && file.offset <= identity.size
                    && file.size <= identity.size
            });
            let start_offset = if can_resume {
                previous.unwrap().offset
            } else {
                0
            };
            let mut stats = previous
                .map(|file| deserialize_day_stats(&file.stats))
                .unwrap_or_default();
            #[cfg(test)]
            {
                let hook = self
                    .before_current_scan
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .clone();
                if let Some(hook) = hook {
                    hook(file_path);
                }
            }
            let result = scan_jsonl_tail_checked(
                file_path,
                start_offset,
                identity.size,
                None,
                Some(identity.clone()),
                |record| apply_record(record, &mut stats),
            )
            .await
            .map_err(|err| err.to_string())?;
            total_bytes += result.bytes_read;
            next.insert(
                key,
                CurrentDayFileState {
                    file_name: name.to_string(),
                    dev: identity.dev,
                    ino: identity.ino,
                    birthtime_ms: identity.birthtime_ms,
                    offset: result.next_offset,
                    size: identity.size,
                    stats: serialize_day_stats(&stats),
                },
            );
        }
        self.scan_bytes
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .push(total_bytes);
        let mut files: Vec<_> = next.into_values().collect();
        files.sort_by(|left, right| left.file_name.cmp(&right.file_name));
        Ok(CurrentDayState {
            version: 1,
            day: state.day,
            files,
        })
    }

    async fn list_output_files(&self) -> Vec<String> {
        let mut names = Vec::new();
        let Ok(mut entries) = tokio::fs::read_dir(&self.output_dir).await else {
            return names;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(".jsonl") {
                names.push(
                    Path::new(&self.output_dir)
                        .join(name)
                        .to_string_lossy()
                        .into_owned(),
                );
            }
        }
        names
    }

    async fn load_scan_state(&self) -> ScanState {
        read_json_file::<ScanState>(&self.scan_state_path)
            .await
            .unwrap_or_default()
    }

    async fn load_digest(&self) -> DigestFile {
        read_json_file::<DigestFile>(&self.digest_path)
            .await
            .unwrap_or(DigestFile {
                version: 1,
                days: HashMap::new(),
            })
    }

    async fn load_current_day_state(&self) -> Option<CurrentDayState> {
        let data = read_json_file::<CurrentDayState>(&self.current_day_state_path).await?;
        if data.version != 1 || data.day.is_empty() {
            return None;
        }
        for file in &data.files {
            if file.file_name.is_empty() {
                return None;
            }
            let _ = deserialize_day_stats(&file.stats);
        }
        Some(data)
    }
}

async fn scan_file(path: &str, start: u64, end: u64, stats: &mut DayStats) -> Result<u64, String> {
    let result = scan_jsonl_tail(path, start, end, None, |record| apply_record(record, stats))
        .await
        .map_err(|err| err.to_string())?;
    Ok(result.next_offset)
}

fn apply_record(record: &Map<String, Value>, stats: &mut DayStats) {
    stats.events += 1;
    let event_name = record_string(record, "event.name");
    let session_id = record_string(record, "gen_ai.session.id");
    let agent_type = record_string(record, "gen_ai.agent.type").unwrap_or_else(|| "unknown".into());
    if let Some(session_id) = session_id.clone() {
        stats.sessions.insert(session_id);
    }
    {
        let agent = stats
            .agent_stats
            .entry(agent_type.clone())
            .or_insert_with(|| AgentStats {
                sessions: BTreeSet::new(),
                events: 0,
                tokens: 0.0,
            });
        agent.events += 1;
        if let Some(session_id) = session_id.clone() {
            agent.sessions.insert(session_id);
        }
    }
    if let Some(repo) = record_string(record, "git.repo") {
        let entry = stats.repo_stats.entry(repo).or_insert_with(|| RepoStats {
            sessions: BTreeSet::new(),
            events: 0,
        });
        entry.events += 1;
        if let Some(session_id) = session_id.clone() {
            entry.sessions.insert(session_id);
        }
    }
    if matches!(
        event_name.as_deref(),
        Some("llm.request" | "gen_ai.model.request")
    ) {
        stats.requests += 1;
    }
    if matches!(
        event_name.as_deref(),
        Some("tool.call" | "gen_ai.tool.call")
    ) {
        stats.tool_calls += 1;
    }
    if matches!(
        event_name.as_deref(),
        Some("llm.response" | "gen_ai.model.response")
    ) {
        let input_tokens = to_number(record.get("gen_ai.usage.input_tokens"));
        let output_tokens = to_number(record.get("gen_ai.usage.output_tokens"));
        let cache_read = to_number(record.get("gen_ai.usage.cache_read.input_tokens"));
        let cache_creation = to_number(record.get("gen_ai.usage.cache_creation.input_tokens"));
        let total_tokens = to_number(record.get("gen_ai.usage.total_tokens"));
        let effective = if total_tokens > 0.0 {
            total_tokens
        } else {
            input_tokens + output_tokens
        };
        stats.tokens += effective;
        stats.input_tokens += input_tokens;
        stats.output_tokens += output_tokens;
        stats.cache_read_tokens += cache_read;
        stats.cache_creation_tokens += cache_creation;
        if let Some(agent) = stats.agent_stats.get_mut(&agent_type) {
            agent.tokens += effective;
        }
        let model = record_string(record, "gen_ai.request.model")
            .or_else(|| record_string(record, "gen_ai.response.model"))
            .unwrap_or_else(|| "unknown".into());
        let model_entry = stats.model_tokens.entry(model).or_insert(ModelTokens {
            total: 0.0,
            input: 0.0,
            cache_read: 0.0,
        });
        model_entry.total += effective;
        model_entry.input += input_tokens;
        model_entry.cache_read += cache_read;
        let provider =
            record_string(record, "gen_ai.provider.name").unwrap_or_else(|| "unknown".into());
        *stats.provider_tokens.entry(provider).or_insert(0.0) += effective;
    }
}

fn day_stats_to_digest(stats: &DayStats, existing: Option<&DayDigest>) -> DayDigest {
    if let Some(existing) = existing {
        if stats.events == 0 {
            return existing.clone();
        }
    }
    DayDigest {
        tokens: existing.map(|item| item.tokens).unwrap_or(0.0) + stats.tokens,
        input_tokens: existing.map(|item| item.input_tokens).unwrap_or(0.0) + stats.input_tokens,
        output_tokens: existing.map(|item| item.output_tokens).unwrap_or(0.0) + stats.output_tokens,
        cache_read_tokens: existing.map(|item| item.cache_read_tokens).unwrap_or(0.0)
            + stats.cache_read_tokens,
        cache_creation_tokens: existing
            .map(|item| item.cache_creation_tokens)
            .unwrap_or(0.0)
            + stats.cache_creation_tokens,
        sessions: existing.map(|item| item.sessions).unwrap_or(0) + stats.sessions.len() as u64,
        requests: existing.map(|item| item.requests).unwrap_or(0) + stats.requests,
        tool_calls: existing.map(|item| item.tool_calls).unwrap_or(0) + stats.tool_calls,
        events: existing.map(|item| item.events).unwrap_or(0) + stats.events,
    }
}

fn prune_digest(digest: &mut DigestFile, today: &str) {
    let cutoff = date_days_ago(DIGEST_MAX_DAYS, today);
    digest.days.retain(|day, _| day.as_str() >= cutoff.as_str());
}

fn build_summary(
    digest: &DigestFile,
    today_live: &DayStats,
    today: &str,
    package_version: &str,
) -> MetricsSummary {
    let mut live = HashMap::new();
    live.insert(today.to_string(), today_live.clone());
    let today_days = vec![today.to_string()];
    let days7 = days_in_range(7, today);
    let days30 = days_in_range(30, today);
    MetricsSummary {
        version: 1,
        generated_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        package_version: package_version.to_string(),
        ranges: MetricsRanges {
            today: build_range_data(&today_days, digest, &live, today),
            seven_days: build_range_data(&days7, digest, &live, today),
            thirty_days: build_range_data(&days30, digest, &live, today),
        },
        daily_tokens: build_daily_points(&days30, digest, today_live, today, true),
        daily_sessions: build_daily_points(&days30, digest, today_live, today, false),
    }
}

fn build_range_data(
    days: &[String],
    digest: &DigestFile,
    live_stats: &HashMap<String, DayStats>,
    today: &str,
) -> MetricsSummaryRangeData {
    let mut total_tokens = 0.0;
    let mut input_tokens = 0.0;
    let mut output_tokens = 0.0;
    let mut cache_read_tokens = 0.0;
    let mut cache_creation_tokens = 0.0;
    let mut total_sessions = 0_u64;
    let mut total_requests = 0_u64;
    let mut total_tool_calls = 0_u64;
    let mut total_events = 0_u64;
    let mut model_map: BTreeMap<String, ModelTokens> = BTreeMap::new();
    let mut agent_map: BTreeMap<String, (u64, u64, f64)> = BTreeMap::new();
    let mut provider_map: BTreeMap<String, f64> = BTreeMap::new();
    let mut repo_map: BTreeMap<String, (u64, u64)> = BTreeMap::new();
    for day in days {
        if day == today {
            if let Some(live) = live_stats.get(day) {
                total_tokens += live.tokens;
                input_tokens += live.input_tokens;
                output_tokens += live.output_tokens;
                cache_read_tokens += live.cache_read_tokens;
                cache_creation_tokens += live.cache_creation_tokens;
                total_sessions += live.sessions.len() as u64;
                total_requests += live.requests;
                total_tool_calls += live.tool_calls;
                total_events += live.events;
                for (model, data) in &live.model_tokens {
                    let entry = model_map.entry(model.clone()).or_insert(ModelTokens {
                        total: 0.0,
                        input: 0.0,
                        cache_read: 0.0,
                    });
                    entry.total += data.total;
                    entry.input += data.input;
                    entry.cache_read += data.cache_read;
                }
                for (agent, data) in &live.agent_stats {
                    let entry = agent_map.entry(agent.clone()).or_insert((0, 0, 0.0));
                    entry.0 += data.sessions.len() as u64;
                    entry.1 += data.events;
                    entry.2 += data.tokens;
                }
                for (provider, tokens) in &live.provider_tokens {
                    *provider_map.entry(provider.clone()).or_insert(0.0) += tokens;
                }
                for (repo, data) in &live.repo_stats {
                    let entry = repo_map.entry(repo.clone()).or_insert((0, 0));
                    entry.0 += data.sessions.len() as u64;
                    entry.1 += data.events;
                }
                continue;
            }
        }
        let Some(digest_day) = digest.days.get(day) else {
            continue;
        };
        total_tokens += digest_day.tokens;
        input_tokens += digest_day.input_tokens;
        output_tokens += digest_day.output_tokens;
        cache_read_tokens += digest_day.cache_read_tokens;
        cache_creation_tokens += digest_day.cache_creation_tokens;
        total_sessions += digest_day.sessions;
        total_requests += digest_day.requests;
        total_tool_calls += digest_day.tool_calls;
        total_events += digest_day.events;
    }
    MetricsSummaryRangeData {
        total_tokens,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_creation_tokens,
        total_sessions,
        total_requests,
        total_tool_calls,
        total_events,
        model_shares: build_model_shares(&model_map, total_tokens),
        agent_shares: build_agent_shares(&agent_map, total_events),
        provider_shares: build_provider_shares(&provider_map, total_tokens),
        repo_shares: build_repo_shares(&repo_map),
    }
}

fn build_daily_points(
    days: &[String],
    digest: &DigestFile,
    today_live: &DayStats,
    today: &str,
    tokens: bool,
) -> Vec<DailyPoint> {
    days.iter()
        .map(|day| {
            let value = if day == today {
                if tokens {
                    today_live.tokens as u64
                } else {
                    today_live.sessions.len() as u64
                }
            } else {
                digest
                    .days
                    .get(day)
                    .map(|item| {
                        if tokens {
                            item.tokens as u64
                        } else {
                            item.sessions
                        }
                    })
                    .unwrap_or(0)
            };
            DailyPoint {
                day: day.clone(),
                value,
            }
        })
        .collect()
}

fn build_model_shares(
    model_map: &BTreeMap<String, ModelTokens>,
    total_tokens: f64,
) -> Vec<ModelShareEntry> {
    let mut shares: Vec<_> = model_map
        .iter()
        .map(|(model, data)| ModelShareEntry {
            model: model.clone(),
            total_tokens: data.total,
            input_tokens: data.input,
            cache_read_tokens: data.cache_read,
            share: if total_tokens > 0.0 {
                data.total / total_tokens
            } else {
                0.0
            },
        })
        .collect();
    shares.sort_by(|left, right| {
        right
            .total_tokens
            .partial_cmp(&left.total_tokens)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    shares
}

fn build_agent_shares(
    agent_map: &BTreeMap<String, (u64, u64, f64)>,
    total_events: u64,
) -> Vec<AgentShareEntry> {
    let mut shares: Vec<_> = agent_map
        .iter()
        .map(|(agent, (sessions, events, tokens))| AgentShareEntry {
            agent_type: agent.clone(),
            sessions: *sessions,
            events: *events,
            tokens: *tokens,
            share: if total_events > 0 {
                *events as f64 / total_events as f64
            } else {
                0.0
            },
        })
        .collect();
    shares.sort_by_key(|entry| std::cmp::Reverse(entry.events));
    shares
}

fn build_provider_shares(
    provider_map: &BTreeMap<String, f64>,
    total_tokens: f64,
) -> Vec<ProviderShareEntry> {
    let mut shares: Vec<_> = provider_map
        .iter()
        .map(|(provider, tokens)| ProviderShareEntry {
            provider: provider.clone(),
            total_tokens: *tokens,
            share: if total_tokens > 0.0 {
                tokens / total_tokens
            } else {
                0.0
            },
        })
        .collect();
    shares.sort_by(|left, right| {
        right
            .total_tokens
            .partial_cmp(&left.total_tokens)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    shares
}

fn build_repo_shares(repo_map: &BTreeMap<String, (u64, u64)>) -> Vec<RepoShareEntry> {
    let mut shares: Vec<_> = repo_map
        .iter()
        .map(|(repo, (sessions, events))| RepoShareEntry {
            repo: repo.clone(),
            sessions: *sessions,
            events: *events,
        })
        .collect();
    shares.sort_by_key(|entry| std::cmp::Reverse(entry.events));
    shares
}

fn serialize_day_stats(stats: &DayStats) -> SerializedDayStats {
    SerializedDayStats {
        tokens: stats.tokens,
        input_tokens: stats.input_tokens,
        output_tokens: stats.output_tokens,
        cache_read_tokens: stats.cache_read_tokens,
        cache_creation_tokens: stats.cache_creation_tokens,
        sessions: stats.sessions.iter().cloned().collect(),
        requests: stats.requests,
        tool_calls: stats.tool_calls,
        events: stats.events,
        model_tokens: stats
            .model_tokens
            .iter()
            .map(|(model, data)| {
                (
                    model.clone(),
                    ModelTokenFile {
                        total: data.total,
                        input: data.input,
                        cache_read: data.cache_read,
                    },
                )
            })
            .collect(),
        agent_stats: stats
            .agent_stats
            .iter()
            .map(|(agent, data)| {
                (
                    agent.clone(),
                    AgentStatFile {
                        sessions: data.sessions.iter().cloned().collect(),
                        events: data.events,
                        tokens: data.tokens,
                    },
                )
            })
            .collect(),
        provider_tokens: stats
            .provider_tokens
            .iter()
            .map(|(key, value)| (key.clone(), *value))
            .collect(),
        repo_stats: stats
            .repo_stats
            .iter()
            .map(|(repo, data)| {
                (
                    repo.clone(),
                    RepoStatFile {
                        sessions: data.sessions.iter().cloned().collect(),
                        events: data.events,
                    },
                )
            })
            .collect(),
    }
}

fn deserialize_day_stats(serialized: &SerializedDayStats) -> DayStats {
    let mut stats = DayStats {
        tokens: serialized.tokens,
        input_tokens: serialized.input_tokens,
        output_tokens: serialized.output_tokens,
        cache_read_tokens: serialized.cache_read_tokens,
        cache_creation_tokens: serialized.cache_creation_tokens,
        sessions: serialized.sessions.iter().cloned().collect(),
        requests: serialized.requests,
        tool_calls: serialized.tool_calls,
        events: serialized.events,
        ..DayStats::default()
    };
    for (model, data) in &serialized.model_tokens {
        stats.model_tokens.insert(
            model.clone(),
            ModelTokens {
                total: data.total,
                input: data.input,
                cache_read: data.cache_read,
            },
        );
    }
    for (agent, data) in &serialized.agent_stats {
        stats.agent_stats.insert(
            agent.clone(),
            AgentStats {
                sessions: data.sessions.iter().cloned().collect(),
                events: data.events,
                tokens: data.tokens,
            },
        );
    }
    for (provider, tokens) in &serialized.provider_tokens {
        stats.provider_tokens.insert(provider.clone(), *tokens);
    }
    for (repo, data) in &serialized.repo_stats {
        stats.repo_stats.insert(
            repo.clone(),
            RepoStats {
                sessions: data.sessions.iter().cloned().collect(),
                events: data.events,
            },
        );
    }
    stats
}

fn merge_current_day_stats(state: &CurrentDayState) -> DayStats {
    let mut merged = DayStats::default();
    for file in &state.files {
        merge_day_stats(&mut merged, &deserialize_day_stats(&file.stats));
    }
    merged
}

fn merge_day_stats(target: &mut DayStats, source: &DayStats) {
    target.tokens += source.tokens;
    target.input_tokens += source.input_tokens;
    target.output_tokens += source.output_tokens;
    target.cache_read_tokens += source.cache_read_tokens;
    target.cache_creation_tokens += source.cache_creation_tokens;
    target.requests += source.requests;
    target.tool_calls += source.tool_calls;
    target.events += source.events;
    target.sessions.extend(source.sessions.iter().cloned());
    for (model, data) in &source.model_tokens {
        let entry = target
            .model_tokens
            .entry(model.clone())
            .or_insert(ModelTokens {
                total: 0.0,
                input: 0.0,
                cache_read: 0.0,
            });
        entry.total += data.total;
        entry.input += data.input;
        entry.cache_read += data.cache_read;
    }
    for (agent, data) in &source.agent_stats {
        let entry = target
            .agent_stats
            .entry(agent.clone())
            .or_insert_with(|| AgentStats {
                sessions: BTreeSet::new(),
                events: 0,
                tokens: 0.0,
            });
        entry.events += data.events;
        entry.tokens += data.tokens;
        entry.sessions.extend(data.sessions.iter().cloned());
    }
    for (provider, tokens) in &source.provider_tokens {
        *target
            .provider_tokens
            .entry(provider.clone())
            .or_insert(0.0) += tokens;
    }
    for (repo, data) in &source.repo_stats {
        let entry = target
            .repo_stats
            .entry(repo.clone())
            .or_insert_with(|| RepoStats {
                sessions: BTreeSet::new(),
                events: 0,
            });
        entry.events += data.events;
        entry.sessions.extend(data.sessions.iter().cloned());
    }
}

fn copy_offsets(state: &CurrentDayState, scan_state: &mut ScanState) {
    for file in &state.files {
        scan_state.files.insert(
            file.file_name.clone(),
            ScanFile {
                offset: file.offset,
                size: file.size,
                ino: file.ino,
            },
        );
    }
}

fn record_string(record: &Map<String, Value>, key: &str) -> Option<String> {
    match record.get(key)? {
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

fn to_number(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Number(number)) => number.as_f64().unwrap_or(0.0),
        Some(Value::String(text)) => text
            .parse::<f64>()
            .ok()
            .filter(|number| number.is_finite())
            .unwrap_or(0.0),
        _ => 0.0,
    }
}

fn date_days_ago(days: i64, reference: &str) -> String {
    let date = NaiveDate::parse_from_str(reference, "%Y-%m-%d")
        .unwrap_or_else(|_| Utc::now().date_naive());
    format_date(date - Duration::days(days))
}

fn days_in_range(count: i64, today: &str) -> Vec<String> {
    let base =
        NaiveDate::parse_from_str(today, "%Y-%m-%d").unwrap_or_else(|_| Utc::now().date_naive());
    (0..count)
        .rev()
        .map(|offset| format_date(base - Duration::days(offset)))
        .collect()
}

fn format_date(date: NaiveDate) -> String {
    date.format("%Y-%m-%d").to_string()
}

fn read_package_version(data_dir: &str) -> String {
    let legacy = Path::new(data_dir).join("package").join("VERSION");
    if let Some(version) = read_version_file(&legacy) {
        return version;
    }
    if let Ok(current) = std::fs::read_to_string(Path::new(data_dir).join("current")) {
        let current = current.trim();
        if !current.is_empty() {
            if let Some(version) = read_version_file(
                &Path::new(data_dir)
                    .join("versions")
                    .join(current)
                    .join("VERSION"),
            ) {
                return version;
            }
        }
    }
    "unknown".into()
}

fn read_version_file(path: &Path) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    regex::Regex::new(r"(?m)^version=(.+)$")
        .ok()?
        .captures(&content)
        .and_then(|caps| caps.get(1).map(|item| item.as_str().trim().to_string()))
}

fn file_identity(path: &Path) -> Option<FileIdentity> {
    identity_from_open(&std::fs::File::open(path).ok()?).ok()
}

fn identity_key(dev: u64, ino: u64, birthtime_ms: f64) -> String {
    format!("{dev}:{ino}:{}", birthtime_ms.to_bits())
}

#[allow(dead_code)]
fn _path(path: PathBuf) -> PathBuf {
    path
}

#[cfg(test)]
mod tests {
    use super::MetricsSummaryWriter;
    use crate::types::StatusBarConfig;
    use serde_json::{json, Value};

    fn config() -> StatusBarConfig {
        StatusBarConfig {
            enabled: true,
            metrics_summary_interval_ms: 60_000,
            runtime_refresh_interval_ms: 30_000,
        }
    }

    fn today() -> String {
        crate::utils::get_today_date_string()
    }

    fn response(total: &str, extra: serde_json::Value) -> Value {
        let mut record = json!({
            "event.name": "llm.response",
            "gen_ai.session.id": "session-1",
            "gen_ai.agent.type": "claude-code",
            "gen_ai.request.model": "claude-opus-4-6",
            "gen_ai.usage.input_tokens": "1000",
            "gen_ai.usage.output_tokens": "200",
            "gen_ai.usage.cache_read.input_tokens": "500",
            "gen_ai.usage.cache_creation.input_tokens": "100",
            "gen_ai.usage.total_tokens": total
        });
        if let (Some(target), Some(source)) = (record.as_object_mut(), extra.as_object()) {
            for (key, value) in source {
                target.insert(key.clone(), value.clone());
            }
        }
        record
    }

    fn write_jsonl(dir: &std::path::Path, name: &str, records: &[Value]) {
        std::fs::create_dir_all(dir).unwrap();
        let body = records
            .iter()
            .map(|record| record.to_string())
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        std::fs::write(dir.join(name), body).unwrap();
    }

    async fn summary(dir: &std::path::Path) -> Value {
        let text = tokio::fs::read_to_string(dir.join("logs").join("metrics-summary.json"))
            .await
            .unwrap();
        serde_json::from_str(&text).unwrap()
    }

    #[tokio::test]
    async fn rotation_deletion_and_reused_names_preserve_observed_today_statistics() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("logs/output");
        let day = today();
        let name = format!("claude-code-{day}.jsonl");
        write_jsonl(
            &output,
            &name,
            &[response("10", json!({"gen_ai.session.id":"first"}))],
        );
        let writer = MetricsSummaryWriter::new(dir.path().to_str().unwrap(), config(), None);
        writer.refresh().await;
        assert_eq!(
            summary(dir.path()).await["ranges"]["today"]["totalTokens"],
            10.0
        );
        let archive = output.join(format!("claude-code.part-{}-{day}.jsonl", "a".repeat(32)));
        std::fs::rename(output.join(&name), &archive).unwrap();
        write_jsonl(
            &output,
            &name,
            &[response("20", json!({"gen_ai.session.id":"second"}))],
        );
        writer.refresh().await;
        assert_eq!(
            summary(dir.path()).await["ranges"]["today"]["totalTokens"],
            30.0
        );
        std::fs::remove_file(archive).unwrap();
        writer.refresh().await;
        assert_eq!(
            summary(dir.path()).await["ranges"]["today"]["totalTokens"],
            30.0
        );
        // Keep the old inode alive outside the scan directory while replacing its name.
        std::fs::rename(output.join(&name), dir.path().join("retired-b.jsonl")).unwrap();
        write_jsonl(
            &output,
            &name,
            &[response("40", json!({"gen_ai.session.id":"third"}))],
        );
        writer.refresh().await;
        assert_eq!(
            summary(dir.path()).await["ranges"]["today"]["totalTokens"],
            70.0
        );
        let restarted = MetricsSummaryWriter::new(dir.path().to_str().unwrap(), config(), None);
        restarted.refresh().await;
        assert_eq!(
            summary(dir.path()).await["ranges"]["today"]["totalTokens"],
            70.0
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn sparse_giant_is_skipped_without_retracting_already_observed_statistics() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("logs/output");
        let name = format!("claude-code-{}.jsonl", today());
        write_jsonl(&output, &name, &[response("10", json!({}))]);
        let writer = MetricsSummaryWriter::new(dir.path().to_str().unwrap(), config(), None);
        writer.refresh().await;
        let file = std::fs::OpenOptions::new()
            .write(true)
            .open(output.join(name))
            .unwrap();
        file.set_len(crate::utils::LOCAL_LOG_EMERGENCY_FILE_BYTES + 1)
            .unwrap();
        drop(file);
        tokio::time::timeout(std::time::Duration::from_secs(3), writer.refresh())
            .await
            .unwrap();
        assert_eq!(
            summary(dir.path()).await["ranges"]["today"]["totalTokens"],
            10.0
        );
    }

    #[tokio::test]
    async fn aggregates_tokens_sessions_models_agents_and_resumes() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("logs").join("output");
        let day = today();
        write_jsonl(
            &output,
            &format!("claude-code-{day}.jsonl"),
            &[
                json!({"event.name": "llm.request", "gen_ai.session.id": "session-1", "gen_ai.agent.type": "claude-code"}),
                response("1200", json!({})),
                json!({"event.name": "tool.call", "gen_ai.session.id": "session-1", "gen_ai.agent.type": "claude-code"}),
                json!({"event.name": "tool.call", "gen_ai.session.id": "session-1", "gen_ai.agent.type": "claude-code"}),
            ],
        );
        let writer = MetricsSummaryWriter::new(dir.path().to_str().unwrap(), config(), None);
        writer.refresh().await;
        let parsed = summary(dir.path()).await;
        assert_eq!(parsed["version"], 1);
        assert_eq!(parsed["ranges"]["today"]["totalTokens"], 1200.0);
        assert_eq!(parsed["ranges"]["today"]["inputTokens"], 1000.0);
        assert_eq!(parsed["ranges"]["today"]["outputTokens"], 200.0);
        assert_eq!(parsed["ranges"]["today"]["cacheReadTokens"], 500.0);
        assert_eq!(parsed["ranges"]["today"]["totalRequests"], 1);
        assert_eq!(parsed["ranges"]["today"]["totalToolCalls"], 2);
        assert_eq!(parsed["ranges"]["today"]["totalEvents"], 4);
        assert_eq!(parsed["ranges"]["today"]["totalSessions"], 1);
        assert_eq!(parsed["dailyTokens"].as_array().unwrap().len(), 30);

        write_jsonl(
            &output,
            &format!("cursor-{day}.jsonl"),
            &[
                json!({"event.name": "llm.request", "gen_ai.session.id": "session-1", "gen_ai.agent.type": "cursor"}),
                response("1200", json!({"gen_ai.agent.type": "cursor"})),
                json!({"event.name": "tool.call", "gen_ai.session.id": "session-1", "gen_ai.agent.type": "cursor"}),
            ],
        );
        writer.refresh().await;
        let parsed = summary(dir.path()).await;
        let agents = parsed["ranges"]["today"]["agentShares"].as_array().unwrap();
        let cursor = agents
            .iter()
            .find(|item| item["agentType"] == "cursor")
            .unwrap();
        let claude = agents
            .iter()
            .find(|item| item["agentType"] == "claude-code")
            .unwrap();
        assert_eq!(cursor["events"], 3);
        // This file has four claude records. TypeScript counts every record.
        assert_eq!(claude["events"], 4);
    }

    #[tokio::test]
    async fn incremental_scan_does_not_double_count_or_commit_partial_lines() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("logs").join("output");
        let day = today();
        let file = output.join(format!("claude-code-{day}.jsonl"));
        write_jsonl(
            &output,
            file.file_name().unwrap().to_str().unwrap(),
            &[response(
                "1000",
                json!({"gen_ai.usage.input_tokens": "800", "gen_ai.usage.output_tokens": "200", "gen_ai.usage.cache_read.input_tokens": "0", "gen_ai.usage.cache_creation.input_tokens": "0"}),
            )],
        );
        let writer = MetricsSummaryWriter::new(dir.path().to_str().unwrap(), config(), None);
        writer.refresh().await;
        assert_eq!(
            summary(dir.path()).await["ranges"]["today"]["totalTokens"],
            1000.0
        );
        let extra = response(
            "500",
            json!({"gen_ai.usage.input_tokens": "400", "gen_ai.usage.output_tokens": "100", "gen_ai.usage.cache_read.input_tokens": "0", "gen_ai.usage.cache_creation.input_tokens": "0"}),
        );
        let line = format!("{extra}\n");
        std::fs::OpenOptions::new()
            .append(true)
            .open(&file)
            .unwrap()
            .write_all(line.as_bytes())
            .unwrap();
        writer.refresh().await;
        assert_eq!(
            summary(dir.path()).await["ranges"]["today"]["totalTokens"],
            1500.0
        );
        writer.refresh().await;
        let bytes = writer.current_day_scan_bytes();
        assert_eq!(bytes.len(), 3);
        assert!(bytes[0] > 0);
        assert_eq!(bytes[1], line.len() as u64);
        assert_eq!(bytes[2], 0);

        let partial_dir = tempfile::tempdir().unwrap();
        let partial_output = partial_dir.path().join("logs").join("output");
        let partial = partial_output.join(format!("codex-{day}.jsonl"));
        std::fs::create_dir_all(&partial_output).unwrap();
        let first = format!("{}\n", response("1000", json!({})));
        let second = response("500", json!({})).to_string();
        let split = second.len() / 2;
        std::fs::write(&partial, format!("{first}{}", &second[..split])).unwrap();
        let writer =
            MetricsSummaryWriter::new(partial_dir.path().to_str().unwrap(), config(), None);
        writer.refresh().await;
        assert_eq!(
            summary(partial_dir.path()).await["ranges"]["today"]["totalTokens"],
            1000.0
        );
        let state: Value = serde_json::from_str(
            &std::fs::read_to_string(
                partial_dir
                    .path()
                    .join("cache")
                    .join("metrics-current-day-state.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(state["files"][0]["offset"], first.len() as u64);
        use std::io::Write;
        let mut handle = std::fs::OpenOptions::new()
            .append(true)
            .open(&partial)
            .unwrap();
        writeln!(handle, "{}", &second[split..]).unwrap();
        writer.refresh().await;
        let parsed = summary(partial_dir.path()).await;
        assert_eq!(parsed["ranges"]["today"]["totalTokens"], 1500.0);
        assert_eq!(parsed["ranges"]["today"]["totalEvents"], 2);
    }

    #[tokio::test]
    async fn preserves_observed_statistics_across_replacement_and_truncation() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("logs").join("output");
        let day = today();
        let codex = output.join(format!("codex-{day}.jsonl"));
        write_jsonl(
            &output,
            codex.file_name().unwrap().to_str().unwrap(),
            &[response(
                "1000",
                json!({"gen_ai.agent.type": "codex", "gen_ai.session.id": "codex-old", "gen_ai.provider.name": "openai"}),
            )],
        );
        write_jsonl(
            &output,
            &format!("claude-code-{day}.jsonl"),
            &[response(
                "2000",
                json!({"gen_ai.agent.type": "claude-code", "gen_ai.session.id": "claude-stable", "gen_ai.provider.name": "anthropic"}),
            )],
        );
        let writer = MetricsSummaryWriter::new(dir.path().to_str().unwrap(), config(), None);
        writer.refresh().await;
        let replacement = response(
            "500",
            json!({"gen_ai.agent.type": "codex", "gen_ai.session.id": "codex-new"}),
        );
        let temp = output.join("replacement.jsonl");
        std::fs::write(&temp, format!("{replacement}\n")).unwrap();
        std::fs::rename(&temp, &codex).unwrap();
        writer.refresh().await;
        let parsed = summary(dir.path()).await;
        assert_eq!(parsed["ranges"]["today"]["totalTokens"], 3500.0);
        assert_eq!(parsed["ranges"]["today"]["totalEvents"], 3);
        assert_eq!(parsed["ranges"]["today"]["totalSessions"], 3);

        let truncated = tempfile::tempdir().unwrap();
        let out = truncated.path().join("logs").join("output");
        let file = out.join(format!("codex-{day}.jsonl"));
        write_jsonl(
            &out,
            file.file_name().unwrap().to_str().unwrap(),
            &[response(
                "123456",
                json!({"gen_ai.session.id": "old-session"}),
            )],
        );
        let writer = MetricsSummaryWriter::new(truncated.path().to_str().unwrap(), config(), None);
        writer.refresh().await;
        std::fs::write(
            &file,
            format!(
                "{}\n",
                response("50", json!({"gen_ai.session.id": "new-session"}))
            ),
        )
        .unwrap();
        writer.refresh().await;
        let parsed = summary(truncated.path()).await;
        assert_eq!(parsed["ranges"]["today"]["totalTokens"], 123506.0);
        assert_eq!(parsed["ranges"]["today"]["totalSessions"], 2);
        assert_eq!(parsed["ranges"]["today"]["totalEvents"], 2);
        writer.refresh().await;
        let restarted =
            MetricsSummaryWriter::new(truncated.path().to_str().unwrap(), config(), None);
        restarted.refresh().await;
        assert_eq!(
            summary(truncated.path()).await["ranges"]["today"]["totalTokens"],
            123506.0
        );
    }

    #[tokio::test]
    async fn empty_output_still_writes_a_summary() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("logs").join("output")).unwrap();
        let writer = MetricsSummaryWriter::new(dir.path().to_str().unwrap(), config(), None);
        writer.refresh().await;
        let parsed = summary(dir.path()).await;
        assert_eq!(parsed["ranges"]["today"]["totalTokens"], 0.0);
        assert_eq!(parsed["packageVersion"], "unknown");
    }

    #[tokio::test]
    async fn standard_model_and_tool_names_contribute_metrics_without_rewriting_audit_logs() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("logs/output");
        let name = format!("codex-{}.jsonl", today());
        write_jsonl(
            &output,
            &name,
            &[
                json!({"event.name":"gen_ai.model.request","gen_ai.session.id":"session-1","gen_ai.agent.type":"codex"}),
                response(
                    "1200",
                    json!({"event.name":"gen_ai.model.response","gen_ai.agent.type":"codex"}),
                ),
                json!({"event.name":"gen_ai.tool.call","gen_ai.session.id":"session-1","gen_ai.agent.type":"codex"}),
                json!({"event.name":"gen_ai.agent.invoke","gen_ai.session.id":"session-1","gen_ai.agent.type":"codex"}),
                json!({"event.name":"gen_ai.agent.result","gen_ai.session.id":"session-1","gen_ai.agent.type":"codex"}),
            ],
        );
        let before = std::fs::read(output.join(&name)).unwrap();
        MetricsSummaryWriter::new(dir.path().to_str().unwrap(), config(), None)
            .refresh()
            .await;
        let parsed = summary(dir.path()).await;
        assert_eq!(parsed["ranges"]["today"]["totalRequests"], 1);
        assert_eq!(parsed["ranges"]["today"]["totalToolCalls"], 1);
        assert_eq!(parsed["ranges"]["today"]["totalTokens"], 1200.0);
        assert_eq!(parsed["ranges"]["today"]["inputTokens"], 1000.0);
        assert_eq!(parsed["ranges"]["today"]["outputTokens"], 200.0);
        assert_eq!(parsed["ranges"]["today"]["totalEvents"], 5);
        assert_eq!(std::fs::read(output.join(&name)).unwrap(), before);
    }
}

#[cfg(test)]
#[path = "metrics_summary_migration_tests.rs"]
mod migration_contract_tests;
