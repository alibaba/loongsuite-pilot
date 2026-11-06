//! Port of `src/inputs/base/base-hook-input.ts`.

use super::input_runtime::{HostedInput, InputBody, InputRuntime};
use super::jsonl::{self, decode_complete, record_byte_length};
use super::runtime_metrics::{CommittedInputBatch, InputRuntimeAccumulator};
use crate::checkpoints::{InputState, InputStatePatch};
use crate::types::{AgentActivityEntry, ClientType, CollectionMethod};
use crate::utils::{ensure_dir, get_today_date_string};
use async_trait::async_trait;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::path::Path;

pub const OFFSET_MAP_EXTRA_KEY: &str = "hookLogOffsets";
const RECENT_LOG_FILE_LIMIT: usize = 3;

pub struct HookPaths {
    pub log_dir: String,
    pub log_prefix: String,
    pub cold_start_keep_last_turn_only: bool,
}

#[async_trait]
pub trait HookBody: Send + Sync + 'static {
    fn checkpoint_namespaces(&self) -> Option<Vec<String>> {
        None
    }
    fn id(&self) -> &str;
    fn agent_type(&self) -> ClientType;
    fn paths(&self) -> &HookPaths;
    async fn transform_record(
        &self,
        rt: &InputRuntime,
        record: &mut Map<String, Value>,
    ) -> anyhow::Result<Option<AgentActivityEntry>>;
    fn agent_version(&self) -> String {
        String::new()
    }
    fn before_stop(&self) {}
}

pub struct HookAdapter<T: HookBody> {
    inner: T,
}

impl<T: HookBody> HookAdapter<T> {
    pub fn new(inner: T) -> Self {
        Self { inner }
    }

    pub fn inner(&self) -> &T {
        &self.inner
    }
}

#[async_trait]
impl<T: HookBody> InputBody for HookAdapter<T> {
    fn checkpoint_namespaces(&self) -> Option<Vec<String>> {
        self.inner.checkpoint_namespaces()
    }

    fn id(&self) -> &str {
        self.inner.id()
    }

    fn agent_type(&self) -> ClientType {
        self.inner.agent_type()
    }

    fn collection_method(&self) -> CollectionMethod {
        CollectionMethod::HookJsonl
    }

    fn agent_version(&self) -> String {
        self.inner.agent_version()
    }

    fn before_stop(&self) {
        self.inner.before_stop();
    }

    async fn on_start(&self, _rt: &InputRuntime) -> anyhow::Result<()> {
        ensure_dir(&self.inner.paths().log_dir).await;
        Ok(())
    }

    async fn collect(&self, rt: &InputRuntime) -> anyhow::Result<Vec<AgentActivityEntry>> {
        collect_hook(&self.inner, rt).await
    }
}

pub async fn collect_hook<T: HookBody>(
    body: &T,
    rt: &InputRuntime,
) -> anyhow::Result<Vec<AgentActivityEntry>> {
    let today = get_today_date_string();
    let mut entries = Vec::new();
    let state = rt.state();
    let is_cold_start = state
        .last_file()
        .map(|file| file.is_empty())
        .unwrap_or(true);
    let file_names = list_hook_log_files(body.paths()).await;
    if file_names.is_empty() {
        return Ok(entries);
    }
    let persisted = persisted_offset_map(&state);
    let should_persist = persisted.is_none();
    let mut offsets = if let Some(persisted) = persisted.clone() {
        persisted
    } else {
        seed_offset_map(body.paths(), &file_names, &state, &today).await
    };
    let candidates = candidate_file_names(body.paths(), &file_names, state.last_file(), &today);
    for log_file_name in &candidates {
        let log_file = Path::new(&body.paths().log_dir).join(log_file_name);
        let file_entries = collect_file(
            body,
            rt,
            log_file.to_string_lossy().as_ref(),
            offsets.get(log_file_name).copied().unwrap_or(0.0),
        )
        .await?;
        offsets.insert(log_file_name.clone(), file_entries.offset);
        entries.extend(file_entries.entries);
    }
    let live: std::collections::BTreeSet<&str> = file_names.iter().map(String::as_str).collect();
    let pruned: BTreeMap<String, f64> = offsets
        .into_iter()
        .filter(|(name, _)| live.contains(name.as_str()))
        .collect();
    let newest = candidates.last();
    if let Some(newest) = newest {
        let newest_offset = pruned.get(newest).copied().unwrap_or(0.0);
        if should_persist
            || state.last_file() != Some(newest.as_str())
            || state.last_offset() != Some(newest_offset)
            || offset_map_changed(persisted.as_ref(), &pruned)
        {
            let mut extra = state.extra().unwrap_or(Value::Object(Map::new()));
            if !extra.is_object() {
                extra = Value::Object(Map::new());
            }
            if let Value::Object(map) = &mut extra {
                map.insert(
                    OFFSET_MAP_EXTRA_KEY.to_string(),
                    Value::Object(
                        pruned
                            .iter()
                            .map(|(key, value)| {
                                (
                                    key.clone(),
                                    serde_json::Number::from_f64(*value)
                                        .map(Value::Number)
                                        .unwrap_or(Value::from(0)),
                                )
                            })
                            .collect(),
                    ),
                );
            }
            rt.update_state(InputStatePatch {
                last_file: Some(newest.clone()),
                last_offset: Some(newest_offset),
                extra: Some(extra),
                ..InputStatePatch::default()
            });
        }
    }
    if body.paths().cold_start_keep_last_turn_only && is_cold_start && !entries.is_empty() {
        let turn_ids: Vec<String> = entries.iter().map(turn_id_of).collect();
        let mut unique = turn_ids.clone();
        unique.sort();
        unique.dedup();
        if unique.len() > 1 {
            let last = turn_ids.last().cloned().unwrap_or_else(|| "unknown".into());
            rt.info(
                "cold start detected, skipping historical turns",
                serde_json::json!({
                    "skipped": unique.len() - 1,
                    "totalTurns": unique.len(),
                    "keepTurnId": last,
                })
                .as_object(),
            );
            entries.retain(|entry| turn_id_of(entry) == last);
        }
    }
    Ok(entries)
}

struct FileEntries {
    entries: Vec<AgentActivityEntry>,
    offset: f64,
}

async fn collect_file<T: HookBody>(
    body: &T,
    rt: &InputRuntime,
    log_file: &str,
    start_offset: f64,
) -> anyhow::Result<FileEntries> {
    let mut entries = Vec::new();
    let size = match tokio::fs::metadata(log_file).await {
        Ok(meta) => meta.len(),
        Err(_) => {
            return Ok(FileEntries {
                entries,
                offset: start_offset,
            });
        }
    };
    let mut offset = start_offset;
    if offset > 0.0 && (size as f64) < offset {
        rt.info(
            "file truncated, resetting offset",
            serde_json::json!({
                "file": log_file,
                "recorded": offset,
                "actual": size,
            })
            .as_object(),
        );
        offset = 0.0;
    }
    if (size as f64) <= offset {
        return Ok(FileEntries {
            entries,
            offset: size as f64,
        });
    }
    let requested = size.saturating_sub(offset as u64);
    rt.with_accumulator(|acc| acc.observe_backlog(requested));
    let read = jsonl::read_file_slice(log_file, offset as u64)
        .await?
        .ok_or_else(|| anyhow::anyhow!("hook log disappeared"))?;
    let started = InputRuntimeAccumulator::now();
    rt.with_accumulator(|acc| {
        acc.observe_read(
            read.bytes.len() as u64,
            requested,
            InputRuntimeAccumulator::now() - started,
        );
    });
    let Some(newline) = jsonl::last_newline(&read.bytes) else {
        return Ok(FileEntries { entries, offset });
    };
    let complete_len = newline + 1;
    let checkpoint = offset + complete_len as f64;
    let complete = &read.bytes[..complete_len];
    let (text, ascii) = decode_complete(complete);
    let lines: Vec<&str> = text.split('\n').collect();
    let mut records = 0_u64;
    let mut parse_success = 0_u64;
    let mut parse_failed = 0_u64;
    let mut max_record_bytes = 0_u64;
    let mut record_start = 0_usize;
    for line in lines {
        let Some(record_bytes) = record_byte_length(ascii, line, complete, &mut record_start)
        else {
            break;
        };
        let record_bytes = record_bytes as u64;
        if line.trim().is_empty() {
            continue;
        }
        records += 1;
        max_record_bytes = max_record_bytes.max(record_bytes);
        let mut record = match jsonl::parse_object_line(line) {
            Ok(record) => {
                parse_success += 1;
                record
            }
            Err(err) => {
                parse_failed += 1;
                if !err.contains("not an object") {
                    rt.warn_line(&err, line);
                }
                continue;
            }
        };
        let allowed =
            rt.with_workspace_policy(|policy| policy.allows(&record, rt.agent_type.as_str()));
        if !allowed {
            continue;
        }
        match body.transform_record(rt, &mut record).await {
            Ok(Some(entry)) => entries.push(entry),
            Ok(None) => {}
            Err(err) => {
                rt.warn_line(&err.to_string(), line);
            }
        }
    }
    rt.with_accumulator(|acc| {
        acc.observe_committed_batch(CommittedInputBatch {
            records,
            bytes: complete_len as u64,
            parse_success_records: parse_success,
            parse_failed_records: parse_failed,
            max_record_bytes,
        });
    });
    Ok(FileEntries {
        entries,
        offset: checkpoint,
    })
}

impl InputRuntime {
    fn warn_line(&self, error: &str, line: &str) {
        let preview: String = line.chars().take(200).collect();
        self.warn(
            "invalid JSONL line",
            serde_json::json!({ "error": error, "line": preview }).as_object(),
        );
    }
}

async fn list_hook_log_files(paths: &HookPaths) -> Vec<String> {
    let mut names = Vec::new();
    let mut dir = match tokio::fs::read_dir(&paths.log_dir).await {
        Ok(dir) => dir,
        Err(_) => return names,
    };
    while let Ok(Some(entry)) = dir.next_entry().await {
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_hook_log_file(paths, &name) {
            names.push(name);
        }
    }
    names.sort();
    names
}

fn is_hook_log_file(paths: &HookPaths, file_name: &str) -> bool {
    let prefix = format!("{}-", paths.log_prefix);
    let Some(suffix) = file_name.strip_prefix(&prefix) else {
        return false;
    };
    let Some(date) = suffix.strip_suffix(".jsonl") else {
        return false;
    };
    let parts: Vec<&str> = date.split('-').collect();
    parts.len() == 3
        && parts[0].len() == 4
        && parts[1].len() == 2
        && parts[2].len() == 2
        && parts
            .iter()
            .all(|part| part.chars().all(|ch| ch.is_ascii_digit()))
}

fn candidate_file_names(
    paths: &HookPaths,
    file_names: &[String],
    last_file: Option<&str>,
    today: &str,
) -> Vec<String> {
    let today_file = format!("{}-{today}.jsonl", paths.log_prefix);
    let mut candidates = Vec::new();
    let start = file_names.len().saturating_sub(RECENT_LOG_FILE_LIMIT);
    for name in &file_names[start..] {
        push_unique(&mut candidates, name.clone());
    }
    if let Some(last_file) = last_file {
        if file_names.iter().any(|name| name == last_file) {
            push_unique(&mut candidates, last_file.to_owned());
        }
    }
    if file_names.iter().any(|name| name == &today_file) {
        push_unique(&mut candidates, today_file);
    }
    candidates.sort();
    candidates
}

fn push_unique(items: &mut Vec<String>, value: String) {
    if !items.iter().any(|existing| existing == &value) {
        items.push(value);
    }
}

fn persisted_offset_map(state: &InputState) -> Option<BTreeMap<String, f64>> {
    let extra = state.extra()?;
    let raw = extra.get(OFFSET_MAP_EXTRA_KEY)?;
    let Value::Object(map) = raw else {
        return None;
    };
    let mut offsets = BTreeMap::new();
    for (name, offset) in map {
        if let Some(value) = offset.as_f64() {
            if value.is_finite() && value >= 0.0 {
                offsets.insert(name.clone(), value);
            }
        }
    }
    if offsets.is_empty() {
        None
    } else {
        Some(offsets)
    }
}

fn offset_map_changed(
    previous: Option<&BTreeMap<String, f64>>,
    next: &BTreeMap<String, f64>,
) -> bool {
    let Some(previous) = previous else {
        return true;
    };
    if previous.len() != next.len() {
        return true;
    }
    next.iter()
        .any(|(name, offset)| previous.get(name) != Some(offset))
}

async fn seed_offset_map(
    paths: &HookPaths,
    file_names: &[String],
    state: &InputState,
    today: &str,
) -> BTreeMap<String, f64> {
    let mut offsets = BTreeMap::new();
    for file_name in file_names {
        let log_file = Path::new(&paths.log_dir).join(file_name);
        let size = tokio::fs::metadata(&log_file)
            .await
            .map(|meta| meta.len() as f64)
            .unwrap_or(0.0);
        offsets.insert(file_name.clone(), size);
    }
    let today_file = format!("{}-{today}.jsonl", paths.log_prefix);
    if let Some(last_file) = state.last_file() {
        if file_names.iter().any(|name| name == last_file) {
            offsets.insert(last_file.to_owned(), state.last_offset().unwrap_or(0.0));
            if last_file != today_file && file_names.iter().any(|name| name == &today_file) {
                offsets.insert(today_file, 0.0);
            }
        } else if file_names.iter().any(|name| name == &today_file) {
            offsets.insert(today_file, 0.0);
        }
    } else if file_names.iter().any(|name| name == &today_file) {
        offsets.insert(today_file, 0.0);
    }
    offsets
}

fn turn_id_of(entry: &AgentActivityEntry) -> String {
    entry
        .turn_id
        .clone()
        .filter(|value| !value.is_empty())
        .or_else(|| {
            entry
                .extra
                .get("gen_ai.turn.id")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "unknown".into())
}

pub fn hosted_hook<T: HookBody>(
    body: T,
    logger_name: &str,
    state_store: std::sync::Arc<crate::checkpoints::StateStore>,
    poll_interval_ms: Option<u64>,
) -> std::sync::Arc<HostedInput<HookAdapter<T>>> {
    HostedInput::new(
        HookAdapter::new(body),
        logger_name,
        state_store,
        poll_interval_ms,
    )
}
