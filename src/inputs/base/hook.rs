//! Port of `src/inputs/base/base-hook-input.ts`.

use super::input_runtime::{HostedInput, InputBody, InputRuntime};
use super::jsonl::{self, decode_complete, record_byte_length};
use super::runtime_metrics::{CommittedInputBatch, InputRuntimeAccumulator};
use crate::checkpoints::{InputState, InputStatePatch};
use crate::types::{AgentActivityEntry, ClientType, CollectionMethod};
use crate::utils::{ensure_dir, get_today_date_string};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::path::Path;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

pub const OFFSET_MAP_EXTRA_KEY: &str = "hookLogOffsets";
const MAX_RECORD_BYTES: usize = 32 * 1024 * 1024;

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

async fn collect_hook<T: HookBody>(
    body: &T,
    rt: &InputRuntime,
) -> anyhow::Result<Vec<AgentActivityEntry>> {
    let today = get_today_date_string();
    let mut entries = Vec::new();
    let state = rt.state();
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
    let candidates = &file_names;
    let mut remaining = crate::utils::raw_source::CYCLE_BYTES;
    let saved_extra = state.extra().unwrap_or(Value::Null);
    let replay = if body.paths().cold_start_keep_last_turn_only {
        match serde_json::from_value::<ColdStartReplay>(saved_extra["hookColdStartReplay"].clone())
        {
            Ok(replay) => Some(replay),
            Err(_) if state.last_file().is_none_or(str::is_empty) => {
                Some(prepare_cold_start(body, rt, candidates).await?)
            }
            Err(_) => None,
        }
    } else {
        None
    };
    let mut identities = saved_extra["hookLogIdentities"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    let mut newest = None;
    let mut blocked = saved_extra["hookLogRetentionBlocked"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    let mut resume = None;
    let start = saved_extra["hookLogSweepNext"]
        .as_str()
        .and_then(|next| candidates.iter().position(|name| name == next))
        .unwrap_or(0);
    for log_file_name in candidates.iter().cycle().skip(start).take(candidates.len()) {
        if remaining == 0 {
            resume = Some(log_file_name.clone());
            break;
        }
        let log_file = Path::new(&body.paths().log_dir).join(log_file_name);
        let file_entries = collect_file(
            body,
            rt,
            log_file.to_string_lossy().as_ref(),
            offsets.get(log_file_name).copied().unwrap_or(0.0),
            identities.get(log_file_name).and_then(Value::as_str),
            remaining,
            replay.as_ref().and_then(|replay| {
                replay
                    .files
                    .get(log_file_name)
                    .map(|file| (file, replay.turn_id.as_str()))
            }),
        )
        .await?;
        remaining = remaining.saturating_sub(file_entries.bytes);
        offsets.insert(log_file_name.clone(), file_entries.offset);
        if let Some(identity) = file_entries.identity {
            if identities.get(log_file_name).and_then(Value::as_str) != Some(&identity) {
                blocked.remove(log_file_name);
            }
            identities.insert(log_file_name.clone(), Value::String(identity));
        }
        if file_entries.blocked {
            blocked.insert(log_file_name.clone(), Value::Bool(true));
        }
        if file_entries.bytes > 0 || newest.is_none() && state.last_file().is_none() {
            newest = Some(log_file_name.clone());
        }
        entries.extend(file_entries.entries);
    }
    let live: std::collections::BTreeSet<&str> = file_names.iter().map(String::as_str).collect();
    let pruned: BTreeMap<String, f64> = offsets
        .into_iter()
        .filter(|(name, _)| live.contains(name.as_str()))
        .collect();
    identities.retain(|name, _| live.contains(name.as_str()));
    blocked.retain(|name, _| live.contains(name.as_str()));
    let replay_pending = replay.filter(|replay| {
        replay.files.iter().any(|(name, file)| {
            live.contains(name.as_str())
                && pruned.get(name).copied().unwrap_or(0.0) < file.size as f64
                && identities
                    .get(name)
                    .and_then(Value::as_str)
                    .is_none_or(|identity| identity == file.identity)
        })
    });
    let replay_value = serde_json::json!(replay_pending);
    let newest = newest
        .or_else(|| state.last_file().map(str::to_owned))
        .or_else(|| candidates.last().cloned());
    if let Some(newest) = newest {
        let newest_offset = pruned.get(&newest).copied().unwrap_or(0.0);
        if should_persist
            || state.last_file() != Some(newest.as_str())
            || state.last_offset() != Some(newest_offset)
            || offset_map_changed(persisted.as_ref(), &pruned)
            || saved_extra["hookLogIdentities"].as_object() != Some(&identities)
            || saved_extra["hookLogRetentionBlocked"].as_object() != Some(&blocked)
            || saved_extra["hookLogSweepNext"].as_str() != resume.as_deref()
            || saved_extra["hookColdStartReplay"] != replay_value
        {
            let mut extra = state.extra().unwrap_or(Value::Object(Map::new()));
            if !extra.is_object() {
                extra = Value::Object(Map::new());
            }
            if let Value::Object(map) = &mut extra {
                map.insert("hookLogDir".into(), body.paths().log_dir.clone().into());
                map.insert(
                    "hookLogPrefix".into(),
                    body.paths().log_prefix.clone().into(),
                );
                map.insert("hookLogIdentities".into(), Value::Object(identities));
                map.insert("hookLogRetentionBlocked".into(), Value::Object(blocked));
                map.insert("hookLogSweepNext".into(), serde_json::json!(resume));
                if body.paths().cold_start_keep_last_turn_only {
                    map.insert("hookColdStartReplay".into(), replay_value);
                }
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
    Ok(entries)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ColdStartReplay {
    turn_id: String,
    files: BTreeMap<String, ColdStartFile>,
}

#[derive(Serialize, Deserialize)]
struct ColdStartFile {
    size: u64,
    identity: String,
}

async fn open_hook_file(
    path: &str,
) -> std::io::Result<(
    std::fs::File,
    crate::utils::file_identity::OpenedFileIdentity,
)> {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || {
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
        }
        let file = options.open(path)?;
        let identity = crate::utils::file_identity::identity_from_open(&file)?;
        Ok((file, identity))
    })
    .await
    .map_err(std::io::Error::other)?
}

async fn prepare_cold_start<T: HookBody>(
    body: &T,
    rt: &InputRuntime,
    names: &[String],
) -> anyhow::Result<ColdStartReplay> {
    let mut replay = ColdStartReplay {
        turn_id: "unknown".into(),
        files: BTreeMap::new(),
    };
    let mut found = false;
    for name in names.iter().rev() {
        let path = Path::new(&body.paths().log_dir).join(name);
        let (file, identity) = match open_hook_file(&path.to_string_lossy()).await {
            Ok(opened) => opened,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        replay.files.insert(
            name.clone(),
            ColdStartFile {
                size: identity.size,
                identity: identity.checkpoint_key(),
            },
        );
        if !found {
            if let Some(turn_id) = last_complete_turn(body, rt, file, identity.size).await? {
                replay.turn_id = turn_id;
                found = true;
            }
        }
    }
    Ok(replay)
}

async fn last_complete_turn<T: HookBody>(
    body: &T,
    rt: &InputRuntime,
    file: std::fs::File,
    mut end: u64,
) -> anyhow::Result<Option<String>> {
    let mut file = tokio::fs::File::from_std(file);
    let mut reversed = Vec::new();
    let mut complete = false;
    let mut oversized = false;
    let mut chunk = vec![0_u8; 64 * 1024];
    while end > 0 {
        let start = end.saturating_sub(chunk.len() as u64);
        let bytes = &mut chunk[..(end - start) as usize];
        file.seek(std::io::SeekFrom::Start(start)).await?;
        file.read_exact(bytes).await?;
        for &byte in bytes.iter().rev() {
            if byte == b'\n' {
                if complete && !oversized {
                    if let Some(turn) = replay_turn(body, rt, &mut reversed).await {
                        return Ok(Some(turn));
                    }
                }
                reversed.clear();
                complete = true;
                oversized = false;
            } else if complete && !oversized {
                if reversed.len() < MAX_RECORD_BYTES {
                    reversed.push(byte);
                } else {
                    oversized = true;
                }
            }
        }
        end = start;
    }
    if complete && !oversized {
        return Ok(replay_turn(body, rt, &mut reversed).await);
    }
    Ok(None)
}

async fn replay_turn<T: HookBody>(
    body: &T,
    rt: &InputRuntime,
    reversed: &mut [u8],
) -> Option<String> {
    reversed.reverse();
    let line = String::from_utf8_lossy(reversed);
    let mut record = jsonl::parse_object_line(&line).ok()?;
    if !rt.with_workspace_policy(|policy| policy.allows(&record, rt.agent_type.as_str())) {
        return None;
    }
    body.transform_record(rt, &mut record)
        .await
        .ok()
        .flatten()
        .map(|entry| turn_id_of(&entry))
}

struct FileEntries {
    entries: Vec<AgentActivityEntry>,
    offset: f64,
    identity: Option<String>,
    bytes: u64,
    blocked: bool,
}

async fn collect_file<T: HookBody>(
    body: &T,
    rt: &InputRuntime,
    log_file: &str,
    start_offset: f64,
    previous_identity: Option<&str>,
    budget: u64,
    replay: Option<(&ColdStartFile, &str)>,
) -> anyhow::Result<FileEntries> {
    let mut entries = Vec::new();
    let opened = open_hook_file(log_file).await;
    let Ok((file, file_identity)) = opened else {
        return Ok(FileEntries {
            entries,
            offset: start_offset,
            identity: None,
            bytes: 0,
            blocked: false,
        });
    };
    let replay = replay.filter(|(file, _)| file_identity.matches_checkpoint(&file.identity));
    let size = file_identity.size;
    let identity = Some(file_identity.checkpoint_key());
    let mut offset = if previous_identity.is_some_and(|old| !file_identity.matches_checkpoint(old))
    {
        0.0
    } else {
        start_offset
    };
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
            identity,
            bytes: 0,
            blocked: false,
        });
    }
    let requested = size.saturating_sub(offset as u64);
    rt.with_accumulator(|acc| acc.observe_backlog(requested));
    // An in-place rewrite can complete a line without changing file metadata.
    // Read again from the committed offset on every poll.
    let started = InputRuntimeAccumulator::now();
    let mut file = tokio::fs::File::from_std(file);
    file.seek(std::io::SeekFrom::Start(offset as u64)).await?;
    let mut bytes = vec![0_u8; requested.min(budget) as usize];
    let mut filled = 0;
    while filled < bytes.len() {
        let count = file.read(&mut bytes[filled..]).await?;
        if count == 0 {
            break;
        }
        filled += count;
    }
    bytes.truncate(filled);
    // A record crossing the ordinary read budget is indivisible. Only extend
    // when it is the first record, with a fixed upper bound on retained bytes.
    while !bytes.contains(&b'\n')
        && bytes.len() < MAX_RECORD_BYTES
        && (bytes.len() as u64) < requested
    {
        let length = (requested - bytes.len() as u64)
            .min(64 * 1024)
            .min((MAX_RECORD_BYTES - bytes.len()) as u64) as usize;
        let old = bytes.len();
        bytes.resize(old + length, 0);
        let count = file.read(&mut bytes[old..]).await?;
        bytes.truncate(old + count);
        if count == 0 {
            break;
        }
        if bytes[old..].contains(&b'\n') {
            break;
        }
    }
    let physical_bytes = bytes.len() as u64;
    rt.with_accumulator(|acc| {
        acc.observe_read(
            bytes.len() as u64,
            requested,
            InputRuntimeAccumulator::now() - started,
        );
    });
    let Some(newline) = jsonl::last_newline(&bytes) else {
        let blocked = bytes.len() >= MAX_RECORD_BYTES;
        if blocked {
            rt.warn(
                "oversized raw Hook record retained",
                serde_json::json!({"bytes":physical_bytes}).as_object(),
            );
        }
        return Ok(FileEntries {
            entries,
            offset,
            identity,
            bytes: physical_bytes,
            blocked,
        });
    };
    let complete_len = newline + 1;
    let checkpoint = offset + complete_len as f64;
    let complete = &bytes[..complete_len];
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
        if ascii {
            record_start += record_bytes;
        }
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
            Ok(Some(entry)) => {
                if replay.is_none_or(|(file, turn)| {
                    offset as u64 + record_start as u64 > file.size || turn_id_of(&entry) == turn
                }) {
                    entries.push(entry);
                }
            }
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
        identity,
        bytes: physical_bytes,
        blocked: false,
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
    names.sort_by_cached_key(|name| {
        (
            crate::utils::raw_source::base_name(name),
            crate::utils::raw_source::segment(name).map_or(0, |(_, sequence)| sequence),
        )
    });
    names
}

fn is_hook_log_file(paths: &HookPaths, file_name: &str) -> bool {
    crate::utils::raw_source::day(file_name, &paths.log_prefix).is_some()
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
        if crate::utils::raw_source::segment(file_name).is_some() {
            continue;
        }
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
