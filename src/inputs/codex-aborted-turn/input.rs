//! Codex aborted-turn recovery input. Port of `codex-aborted-turn-input.ts`.
//!
//! Completed turns stay with the transcript collector. This input only emits a
//! cancelled trace when a rollout records `turn_aborted` for the active turn
//! and the Hook state file for that session is not required to build the trace.

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Map, Value};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use crate::checkpoints::{InputStatePatch, StateStore};
use crate::inputs::base::{HostedInput, InputBody, InputRuntime};
use crate::types::{AgentActivityEntry, ClientType, CollectionMethod};
use crate::utils::{directory_exists, resolve_home, DEFAULT_POLL_INTERVAL_MS};

use super::builder::build_codex_aborted_turn_entries;
use super::extractor::{
    extract_aborted_turn, extract_codex_transcript_meta, session_id_from_transcript_path,
};
use super::types::{
    CodexAbortedCheckpoint, CodexActiveTurn, CodexCompletedTurn, MAX_EMITTED_ABORTED_TURNS,
    MAX_PENDING_COMPLETED_TURNS,
};
use super::utils::{now_ms, string_value, timestamp_ms};

const DEFAULT_SESSION_DIR: &str = "~/.codex/sessions";
const DEFAULT_HOOK_STATE_DIR: &str = "~/.loongsuite-pilot/state/codex/sessions";
const DEFAULT_DIAGNOSTIC_DIR: &str = "~/.loongsuite-pilot/logs/diagnostics";
const DEFAULT_HOOK_GAP_GRACE_MS: f64 = 60_000.0;

pub struct CodexAbortedTurnInputOptions {
    pub state_store: Arc<StateStore>,
    pub session_dir: Option<String>,
    pub hook_state_dir: Option<String>,
    pub diagnostic_dir: Option<String>,
    pub hook_gap_grace_ms: Option<f64>,
    pub poll_interval_ms: Option<u64>,
}

pub struct CodexAbortedTurnInput {
    pub inner: Arc<HostedInput<CodexAbortedTurnBody>>,
}

pub struct CodexAbortedTurnBody {
    session_dir: String,
    hook_state_dir: String,
    diagnostic_dir: String,
    hook_gap_grace_ms: f64,
}

struct JsonLine {
    start_offset: i64,
    end_offset: i64,
    record: Map<String, Value>,
}

impl CodexAbortedTurnInput {
    pub(crate) fn collector_runtime_info(&self) -> crate::inputs::base::InputRuntimeInfo {
        self.inner.runtime.runtime_info()
    }

    pub fn new(opts: CodexAbortedTurnInputOptions) -> Self {
        let poll = opts.poll_interval_ms.or(Some(DEFAULT_POLL_INTERVAL_MS));
        Self {
            inner: HostedInput::new(
                CodexAbortedTurnBody {
                    session_dir: opts
                        .session_dir
                        .unwrap_or_else(|| resolve_home(DEFAULT_SESSION_DIR)),
                    hook_state_dir: opts
                        .hook_state_dir
                        .unwrap_or_else(|| resolve_home(DEFAULT_HOOK_STATE_DIR)),
                    diagnostic_dir: opts
                        .diagnostic_dir
                        .unwrap_or_else(|| resolve_home(DEFAULT_DIAGNOSTIC_DIR)),
                    hook_gap_grace_ms: opts.hook_gap_grace_ms.unwrap_or(DEFAULT_HOOK_GAP_GRACE_MS),
                },
                "CodexAbortedTurnInput",
                opts.state_store,
                poll,
            ),
        }
    }

    pub fn id(&self) -> &str {
        self.inner.id()
    }

    pub fn agent_type(&self) -> ClientType {
        self.inner.agent_type()
    }

    pub fn collection_method(&self) -> CollectionMethod {
        self.inner.collection_method()
    }

    pub fn collector_running(&self) -> bool {
        self.inner.running()
    }

    pub async fn start(&self) -> Result<(), String> {
        self.inner.start().await
    }

    pub async fn stop(&self) -> Result<(), String> {
        self.inner.stop().await
    }

    pub async fn run_cycle(&self) {
        self.inner.run_cycle().await;
    }

    pub fn bind_collector(
        &self,
        on_entries: impl Fn(&[AgentActivityEntry]) + Send + Sync + 'static,
        on_delta: impl Fn(&crate::inputs::base::InputRuntimeDelta) + Send + Sync + 'static,
    ) {
        self.inner.on_entries(on_entries);
        self.inner.on_runtime_delta(on_delta);
    }

    pub fn on_entries(&self, handler: impl Fn(&[AgentActivityEntry]) + Send + Sync + 'static) {
        self.inner.on_entries(handler);
    }

    pub fn watch_paths() -> Vec<String> {
        vec![resolve_home(DEFAULT_SESSION_DIR)]
    }

    pub async fn check_availability() -> bool {
        directory_exists(&resolve_home(DEFAULT_SESSION_DIR)).await
    }
}

#[async_trait]
impl InputBody for CodexAbortedTurnBody {
    fn checkpoint_namespaces(&self) -> Option<Vec<String>> {
        Some(vec![self.id().to_owned()])
    }

    fn id(&self) -> &str {
        "codex-aborted-turn"
    }

    fn agent_type(&self) -> ClientType {
        ClientType::CodexCliHook
    }

    fn collection_method(&self) -> CollectionMethod {
        CollectionMethod::SessionFilePolling
    }

    async fn on_start(&self, rt: &InputRuntime) -> anyhow::Result<()> {
        for file_path in discover_session_files(&self.session_dir).await {
            let key = state_key(&file_path);
            if read_checkpoint(rt, &key).is_some() {
                continue;
            }
            baseline_file(rt, &file_path, &key).await;
        }
        Ok(())
    }

    async fn collect(&self, rt: &InputRuntime) -> anyhow::Result<Vec<AgentActivityEntry>> {
        let mut entries = Vec::new();
        for file_path in discover_session_files(&self.session_dir).await {
            entries.extend(self.process_file(rt, &file_path).await?);
        }
        Ok(entries)
    }
}

impl CodexAbortedTurnBody {
    async fn process_file(
        &self,
        rt: &InputRuntime,
        file_path: &str,
    ) -> anyhow::Result<Vec<AgentActivityEntry>> {
        let (mut file, identity) = match open_rollout_file(file_path).await {
            Ok(opened) => opened,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };
        self.process_opened_file(rt, file_path, &mut file, &identity)
            .await
    }

    async fn process_opened_file(
        &self,
        rt: &InputRuntime,
        file_path: &str,
        file: &mut tokio::fs::File,
        identity: &crate::utils::file_identity::OpenedFileIdentity,
    ) -> anyhow::Result<Vec<AgentActivityEntry>> {
        let inode = identity.ino;
        let size = i64::try_from(identity.size).unwrap_or(i64::MAX);
        let key = state_key(file_path);
        let mut checkpoint = match read_checkpoint(rt, &key) {
            Some(checkpoint) => checkpoint,
            None => CodexAbortedCheckpoint {
                inode,
                dev: Some(identity.dev),
                scan_offset: 0,
                active_turn: None,
                latest_session_meta_offset: None,
                latest_session_id: None,
                emitted_aborted_turn_ids: Vec::new(),
                pending_completed_turns: Vec::new(),
                emitted_hook_gap_turn_ids: Vec::new(),
            },
        };
        if checkpoint.inode != inode || checkpoint.dev.is_some_and(|dev| dev != identity.dev) {
            baseline_opened_file(rt, file, identity, &key).await;
            return Ok(Vec::new());
        }
        checkpoint.dev = Some(identity.dev);
        if size <= checkpoint.scan_offset {
            self.emit_due_hook_gap_warnings(rt, &mut checkpoint).await;
            save_checkpoint(rt, &key, &checkpoint);
            return Ok(Vec::new());
        }
        let lines = read_json_lines(file, checkpoint.scan_offset, size).await?;
        if lines.next_offset == checkpoint.scan_offset {
            return Ok(Vec::new());
        }
        let mut entries = Vec::new();
        for line in &lines.items {
            let Some(payload) = line.record.get("payload").and_then(Value::as_object) else {
                continue;
            };
            let record_type = line.record.get("type").and_then(Value::as_str);
            if record_type == Some("session_meta") {
                checkpoint.latest_session_meta_offset = Some(line.start_offset);
                if let Some(meta) = extract_codex_transcript_meta(&line.record) {
                    if !meta.session_id.is_empty() {
                        checkpoint.latest_session_id = Some(meta.session_id);
                    }
                }
                continue;
            }
            if record_type == Some("event_msg")
                && payload.get("type").and_then(Value::as_str) == Some("task_started")
            {
                if let Some(turn_id) = string_value(payload.get("turn_id")) {
                    if checkpoint
                        .active_turn
                        .as_ref()
                        .is_none_or(|active| active.turn_id != turn_id)
                    {
                        checkpoint.active_turn = Some(CodexActiveTurn {
                            turn_id: turn_id.to_owned(),
                            start_offset: line.start_offset,
                            started_at_ms: timestamp_ms(&line.record).unwrap_or_else(now_ms),
                        });
                    }
                }
                continue;
            }
            if record_type == Some("turn_context") {
                if let Some(turn_id) = string_value(payload.get("turn_id")) {
                    if checkpoint
                        .active_turn
                        .as_ref()
                        .is_none_or(|active| active.turn_id != turn_id)
                    {
                        checkpoint.active_turn = Some(CodexActiveTurn {
                            turn_id: turn_id.to_owned(),
                            start_offset: line.start_offset,
                            started_at_ms: timestamp_ms(&line.record).unwrap_or_else(now_ms),
                        });
                    }
                }
                continue;
            }
            if record_type != Some("event_msg") {
                continue;
            }
            if payload.get("type").and_then(Value::as_str) == Some("task_complete") {
                if let Some(turn_id) = string_value(payload.get("turn_id")) {
                    let active_matches = checkpoint
                        .active_turn
                        .as_ref()
                        .is_some_and(|active| active.turn_id == turn_id);
                    if active_matches
                        && !checkpoint
                            .emitted_hook_gap_turn_ids
                            .iter()
                            .any(|id| id == turn_id)
                    {
                        checkpoint.pending_completed_turns.push(CodexCompletedTurn {
                            turn_id: turn_id.to_owned(),
                            session_id: checkpoint
                                .latest_session_id
                                .clone()
                                .unwrap_or_else(|| session_id_from_transcript_path(file_path)),
                            completed_at_ms: timestamp_ms(&line.record).unwrap_or_else(now_ms),
                        });
                        let len = checkpoint.pending_completed_turns.len();
                        if len > MAX_PENDING_COMPLETED_TURNS {
                            checkpoint
                                .pending_completed_turns
                                .drain(..len - MAX_PENDING_COMPLETED_TURNS);
                        }
                        checkpoint.active_turn = None;
                    }
                }
                continue;
            }
            if payload.get("type").and_then(Value::as_str) != Some("turn_aborted") {
                continue;
            }
            let Some(turn_id) = string_value(payload.get("turn_id")) else {
                continue;
            };
            if checkpoint
                .active_turn
                .as_ref()
                .is_none_or(|active| active.turn_id != turn_id)
            {
                continue;
            }
            if !checkpoint
                .emitted_aborted_turn_ids
                .iter()
                .any(|id| id == turn_id)
            {
                let recovered = self
                    .recover_turn(file_path, file, size, &checkpoint, line.end_offset)
                    .await?;
                if recovered.is_empty() {
                    self.emit_recovery_failure_diagnostic(rt, file_path, turn_id, &line.record)
                        .await;
                } else {
                    entries.extend(recovered);
                    checkpoint
                        .emitted_aborted_turn_ids
                        .insert(0, turn_id.to_owned());
                    checkpoint
                        .emitted_aborted_turn_ids
                        .truncate(MAX_EMITTED_ABORTED_TURNS);
                }
            }
            checkpoint.active_turn = None;
        }
        checkpoint.scan_offset = lines.next_offset;
        self.emit_due_hook_gap_warnings(rt, &mut checkpoint).await;
        save_checkpoint(rt, &key, &checkpoint);
        Ok(entries)
    }

    async fn recover_turn(
        &self,
        file_path: &str,
        file: &mut tokio::fs::File,
        size: i64,
        checkpoint: &CodexAbortedCheckpoint,
        abort_end_offset: i64,
    ) -> anyhow::Result<Vec<AgentActivityEntry>> {
        let Some(active) = &checkpoint.active_turn else {
            return Ok(Vec::new());
        };
        let range = read_json_lines(file, active.start_offset, abort_end_offset).await?;
        let meta_record = match checkpoint.latest_session_meta_offset {
            Some(offset) => read_json_line_at(file, offset, size).await?,
            None => None,
        };
        let meta = meta_record.as_ref().and_then(extract_codex_transcript_meta);
        let records: Vec<Map<String, Value>> =
            range.items.into_iter().map(|line| line.record).collect();
        let Some(turn) = extract_aborted_turn(
            &records,
            meta.as_ref(),
            &session_id_from_transcript_path(file_path),
            &active.turn_id,
        ) else {
            return Ok(Vec::new());
        };
        Ok(build_codex_aborted_turn_entries(&turn))
    }

    async fn emit_due_hook_gap_warnings(
        &self,
        rt: &InputRuntime,
        checkpoint: &mut CodexAbortedCheckpoint,
    ) {
        let now = now_ms();
        let mut pending = Vec::new();
        let completed = std::mem::take(&mut checkpoint.pending_completed_turns);
        for item in completed {
            if now - item.completed_at_ms < self.hook_gap_grace_ms {
                pending.push(item);
                continue;
            }
            if has_hook_state(&self.hook_state_dir, &item.session_id).await {
                continue;
            }
            match write_hook_gap(&self.diagnostic_dir, &item, now).await {
                Ok(()) => {
                    let meta = json!({
                        "sessionId": item.session_id,
                        "transcriptTurnId": item.turn_id,
                    });
                    rt.warn(
                        "Codex Hook state missing for completed transcript turn",
                        meta.as_object(),
                    );
                    checkpoint.emitted_hook_gap_turn_ids.insert(0, item.turn_id);
                    checkpoint
                        .emitted_hook_gap_turn_ids
                        .truncate(MAX_PENDING_COMPLETED_TURNS);
                }
                Err(error) => {
                    let meta = json!({
                        "sessionId": item.session_id,
                        "transcriptTurnId": item.turn_id,
                        "error": error,
                    });
                    rt.warn(
                        "failed to write Codex Hook gap diagnostic",
                        meta.as_object(),
                    );
                    pending.push(item);
                }
            }
        }
        checkpoint.pending_completed_turns = pending;
    }

    async fn emit_recovery_failure_diagnostic(
        &self,
        rt: &InputRuntime,
        file_path: &str,
        turn_id: &str,
        abort_record: &Map<String, Value>,
    ) {
        let reason = if timestamp_ms(abort_record).is_none() {
            "missing_or_invalid_abort_timestamp"
        } else {
            "no_entries_recovered"
        };
        match write_recovery_failure(&self.diagnostic_dir, file_path, turn_id, reason).await {
            Ok(()) => {
                let meta = json!({ "filePath": file_path, "turnId": turn_id, "reason": reason });
                rt.warn(
                    "Codex aborted turn recovery produced no entries",
                    meta.as_object(),
                );
            }
            Err(error) => {
                let meta = json!({ "filePath": file_path, "turnId": turn_id, "error": error });
                rt.warn(
                    "failed to write Codex aborted turn recovery diagnostic",
                    meta.as_object(),
                );
            }
        }
    }
}

async fn baseline_file(rt: &InputRuntime, file_path: &str, key: &str) {
    let Ok((mut file, identity)) = open_rollout_file(file_path).await else {
        return;
    };
    baseline_opened_file(rt, &mut file, &identity, key).await;
}

async fn baseline_opened_file(
    rt: &InputRuntime,
    file: &mut tokio::fs::File,
    identity: &crate::utils::file_identity::OpenedFileIdentity,
    key: &str,
) {
    let size = i64::try_from(identity.size).unwrap_or(i64::MAX);
    let Ok(lines) = read_json_lines(file, 0, size).await else {
        return;
    };
    let mut latest = None;
    for line in &lines.items {
        if line.record.get("type").and_then(Value::as_str) == Some("session_meta") {
            latest = Some(line.start_offset);
        }
    }
    save_checkpoint(
        rt,
        key,
        &CodexAbortedCheckpoint {
            inode: identity.ino,
            dev: Some(identity.dev),
            scan_offset: size,
            active_turn: None,
            latest_session_meta_offset: latest,
            latest_session_id: None,
            emitted_aborted_turn_ids: Vec::new(),
            pending_completed_turns: Vec::new(),
            emitted_hook_gap_turn_ids: Vec::new(),
        },
    );
}

async fn discover_session_files(session_dir: &str) -> Vec<String> {
    let mut files = Vec::new();
    collect_rollout_files(session_dir, &mut files).await;
    files.sort();
    files
}

async fn collect_rollout_files(dir: &str, files: &mut Vec<String>) {
    let mut entries = match tokio::fs::read_dir(dir).await {
        Ok(entries) => entries,
        Err(_) => return,
    };
    let mut listed = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        listed.push(entry);
    }
    for entry in listed {
        let path = entry.path();
        let text = path.to_string_lossy().into_owned();
        let Ok(kind) = entry.file_type().await else {
            continue;
        };
        if kind.is_dir() {
            Box::pin(collect_rollout_files(&text, files)).await;
        } else if kind.is_file() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("rollout-") && name.ends_with(".jsonl") {
                files.push(text);
            }
        }
    }
}

fn state_key(file_path: &str) -> String {
    format!("codex-aborted-turn:{file_path}")
}

fn read_checkpoint(rt: &InputRuntime, key: &str) -> Option<CodexAbortedCheckpoint> {
    let extra = rt.state_store.get(key).extra()?;
    let value = extra.get("codexAbortedTurn")?.as_object()?;
    let inode = value.get("inode").and_then(Value::as_u64)?;
    let scan_offset = value
        .get("scanOffset")
        .and_then(Value::as_i64)
        .or_else(|| {
            value
                .get("scanOffset")
                .and_then(Value::as_f64)
                .filter(|value| value.is_finite() && value.fract() == 0.0)
                .map(|value| value as i64)
        })?;
    let active = value.get("activeTurn").and_then(Value::as_object);
    let active_turn = active.and_then(|active| {
        Some(CodexActiveTurn {
            turn_id: active.get("turnId").and_then(Value::as_str)?.to_owned(),
            start_offset: active
                .get("startOffset")
                .and_then(Value::as_i64)
                .or_else(|| {
                    active
                        .get("startOffset")
                        .and_then(Value::as_f64)
                        .map(|value| value as i64)
                })?,
            started_at_ms: active.get("startedAtMs").and_then(Value::as_f64)?,
        })
    });
    let emitted = value
        .get("emittedAbortedTurnIds")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .take(MAX_EMITTED_ABORTED_TURNS)
                .collect()
        })
        .unwrap_or_default();
    let hook_gaps = value
        .get("emittedHookGapTurnIds")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .take(MAX_PENDING_COMPLETED_TURNS)
                .collect()
        })
        .unwrap_or_default();
    Some(CodexAbortedCheckpoint {
        inode,
        dev: value.get("dev").and_then(Value::as_u64),
        scan_offset,
        active_turn,
        latest_session_meta_offset: value.get("latestSessionMetaOffset").and_then(Value::as_i64),
        latest_session_id: value
            .get("latestSessionId")
            .and_then(Value::as_str)
            .map(str::to_owned),
        emitted_aborted_turn_ids: emitted,
        pending_completed_turns: read_completed_turns(value.get("pendingCompletedTurns")),
        emitted_hook_gap_turn_ids: hook_gaps,
    })
}

fn read_completed_turns(value: Option<&Value>) -> Vec<CodexCompletedTurn> {
    let Some(items) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let record = item.as_object()?;
            Some(CodexCompletedTurn {
                turn_id: record.get("turnId").and_then(Value::as_str)?.to_owned(),
                session_id: record.get("sessionId").and_then(Value::as_str)?.to_owned(),
                completed_at_ms: record.get("completedAtMs").and_then(Value::as_f64)?,
            })
        })
        .rev()
        .take(MAX_PENDING_COMPLETED_TURNS)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

fn save_checkpoint(rt: &InputRuntime, key: &str, checkpoint: &CodexAbortedCheckpoint) {
    rt.state_store.update(
        key,
        InputStatePatch {
            last_offset: Some(checkpoint.scan_offset as f64),
            extra: Some(json!({
                "codexAbortedTurn": checkpoint,
            })),
            ..InputStatePatch::default()
        },
    );
}

async fn has_hook_state(hook_state_dir: &str, session_id: &str) -> bool {
    tokio::fs::metadata(Path::new(hook_state_dir).join(format!("{session_id}.json")))
        .await
        .is_ok()
}

async fn write_hook_gap(dir: &str, completed: &CodexCompletedTurn, now: f64) -> Result<(), String> {
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|error| error.to_string())?;
    let day = chrono::DateTime::from_timestamp_millis(completed.completed_at_ms as i64)
        .map(|time| time.format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| "unknown".to_owned());
    let detected = chrono::DateTime::from_timestamp_millis(now as i64)
        .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default();
    let completed_at = chrono::DateTime::from_timestamp_millis(completed.completed_at_ms as i64)
        .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default();
    let line = json!({
        "type": "codex_hook_missing",
        "session_id": completed.session_id,
        "transcript_turn_id": completed.turn_id,
        "completed_at": completed_at,
        "detected_at": detected,
    });
    let path = Path::new(dir).join(format!("codex-hook-gap-{day}.jsonl"));
    append_line(&path, &line).await
}

async fn write_recovery_failure(
    dir: &str,
    file_path: &str,
    turn_id: &str,
    reason: &str,
) -> Result<(), String> {
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|error| error.to_string())?;
    let now = chrono::Utc::now();
    let day = now.format("%Y-%m-%d");
    let line = json!({
        "type": "codex_aborted_turn_recovery_failed",
        "transcript_path": file_path,
        "transcript_turn_id": turn_id,
        "reason": reason,
        "detected_at": now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    });
    let path = Path::new(dir).join(format!("codex-aborted-turn-recovery-failed-{day}.jsonl"));
    append_line(&path, &line).await
}

async fn append_line(path: &Path, value: &Value) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .await
        .map_err(|error| error.to_string())?;
    let mut bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    file.write_all(&bytes)
        .await
        .map_err(|error| error.to_string())
}

struct ReadLines {
    items: Vec<JsonLine>,
    next_offset: i64,
}

async fn read_json_lines(
    file: &mut tokio::fs::File,
    start_offset: i64,
    end_offset: i64,
) -> anyhow::Result<ReadLines> {
    if end_offset <= start_offset {
        return Ok(ReadLines {
            items: Vec::new(),
            next_offset: start_offset,
        });
    }
    file.seek(std::io::SeekFrom::Start(start_offset as u64))
        .await?;
    let mut buffer = vec![0u8; (end_offset - start_offset) as usize];
    file.read_exact(&mut buffer).await?;
    let Some(last_newline) = buffer.iter().rposition(|byte| *byte == b'\n') else {
        return Ok(ReadLines {
            items: Vec::new(),
            next_offset: start_offset,
        });
    };
    let mut items = Vec::new();
    let mut cursor = 0usize;
    while cursor <= last_newline {
        let Some(relative) = buffer[cursor..=last_newline]
            .iter()
            .position(|byte| *byte == b'\n')
        else {
            break;
        };
        let newline = cursor + relative;
        if newline > last_newline {
            break;
        }
        let text = String::from_utf8_lossy(&buffer[cursor..newline]);
        let text = text.trim();
        if !text.is_empty() {
            if let Ok(Value::Object(record)) = serde_json::from_str::<Value>(text) {
                items.push(JsonLine {
                    start_offset: start_offset + cursor as i64,
                    end_offset: start_offset + newline as i64 + 1,
                    record,
                });
            }
        }
        cursor = newline + 1;
    }
    Ok(ReadLines {
        items,
        next_offset: start_offset + last_newline as i64 + 1,
    })
}

async fn read_json_line_at(
    file: &mut tokio::fs::File,
    offset: i64,
    size: i64,
) -> anyhow::Result<Option<Map<String, Value>>> {
    let available = size - offset;
    if available <= 0 {
        return Ok(None);
    }
    let mut size = available.min(64 * 1024);
    while size > 0 {
        let mut buffer = vec![0u8; size as usize];
        file.seek(std::io::SeekFrom::Start(offset as u64)).await?;
        let bytes_read = file.read(&mut buffer).await?;
        if let Some(newline) = buffer[..bytes_read].iter().position(|byte| *byte == b'\n') {
            let text = String::from_utf8_lossy(&buffer[..newline]);
            return Ok(match serde_json::from_str::<Value>(text.trim()) {
                Ok(Value::Object(record)) => Some(record),
                _ => None,
            });
        }
        if bytes_read < size as usize || size == available {
            return Ok(None);
        }
        size = (size * 2).min(available);
    }
    Ok(None)
}

async fn open_rollout_file(
    path: &str,
) -> std::io::Result<(
    tokio::fs::File,
    crate::utils::file_identity::OpenedFileIdentity,
)> {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || {
        let file = std::fs::File::open(path)?;
        let identity = crate::utils::file_identity::identity_from_open(&file)?;
        Ok((tokio::fs::File::from_std(file), identity))
    })
    .await
    .map_err(std::io::Error::other)?
}

#[cfg(test)]
#[path = "identity_tests.rs"]
mod identity_tests;
