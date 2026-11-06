//! Scan, checkpoint, and subagent fusion for [`super::CodexTranscriptBody`].
//! Port of the instance methods in `codex-transcript-input.ts`.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::checkpoints::InputStatePatch;
use crate::inputs::base::{CommittedInputBatch, InputRuntime};
use crate::multimodal::types::{BlobToUriParams, UriResult};
use crate::normalization::{build_agent_activity_entry, is_reserved_key};
use crate::types::{AgentActivityEntry, AgentEventName};

use super::super::builder::{
    build_codex_transcript_segment, next_input_messages_for_step, CodexTranscriptBuildOptions,
};
use super::super::checkpoint::{
    checkpoint_to_value, create_active_turn, empty_checkpoint, new_pending_terminal,
    new_pending_terminal_at, parse_checkpoint, update_active_turn_from_extracted,
    update_active_turn_metadata, MAX_DEFERRED_TERMINALS, MAX_SAFE_INTEGER, RECOVERY_RETRY_MAX_MS,
    RECOVERY_RETRY_MIN_MS,
};
use super::super::discovery::{
    canonical_directory_path, collect_recent_rollout_files, collect_rollout_files, directory_mtime,
    read_codex_wakeup_roots, safe_wakeup_session_part, span_context_marker_name,
    DiscoveredSessionFile, WalkBudget, DYNAMIC_SESSION_FILE_MAX_IDLE_MS,
    MAX_DYNAMIC_DIRECTORIES_PER_ROOT, MAX_DYNAMIC_ROLLOUT_FILES_PER_ROOT, MAX_DYNAMIC_SESSION_DIRS,
    MAX_DYNAMIC_SESSION_FILES, MAX_SPAN_CONTEXTS_PER_CLEANUP, MAX_WAKEUP_MARKERS_FOR_DISCOVERY,
    MAX_WAKEUP_MARKERS_PER_CLEANUP, WAKEUP_MARKER_DISCOVERY_TTL_MS,
};
use super::super::extractor::{
    extract_codex_partial_turn, extract_codex_partial_turn_with_boundaries,
    extract_codex_transcript_meta, session_id_from_transcript_path, ExtractOptions,
};
use super::super::scan::{
    self, file_meta_snapshot, file_mtime_ms, find_turn_start_offset, last_complete_jsonl_offset,
    read_json_line_at, read_json_lines, scan_json_lines, scan_json_lines_through_quarantine,
    select_owner_session_meta_offset, terminal_turn_id_for, turn_id_for_start,
    uuid_v7_timestamp_ms, JsonLine,
};
use super::super::subagent_linker::{
    extract_codex_spawn_descriptors, is_codex_work_input, CodexSpawnDescriptor,
    MAX_LINK_DESCRIPTORS,
};
use super::super::types::{
    CodexActiveTranscriptTurn, CodexDeferredTerminalTurn, CodexForkBootstrap,
    CodexPendingTerminalTurn, CodexTerminalRecoveryFailure, CodexTerminalStatus, CodexThreadSource,
    CodexTranscriptCheckpoint, CodexTranscriptInputContext, CodexTranscriptMeta,
    CodexTranscriptSourceRecord, ForkBootstrapState,
};
use super::super::utils::{self, as_record, json_bytes, now_ms, string_value};
use super::{CachedMeta, CodexTranscriptBody, RolloutStat};

pub(super) const MAX_EMIT_BATCH_ENTRIES: usize = 256;
pub(super) const MAX_EMIT_BATCH_BYTES: usize = 1024 * 1024;
const MAX_PERSISTED_INPUT_CONTEXT_BYTES: usize = 1024 * 1024;
const MAX_TERMINALS_PER_FILE_CYCLE: usize = 100;

struct TerminalFailureContext {
    start_offset: i64,
    phase: &'static str,
    deferred: bool,
}

const MAX_SCAN_BYTES_PER_FILE_CYCLE: i64 = 16 * 1024 * 1024;
const MAX_CACHED_INCOMPLETE_TAILS: usize = 2048;
const INCOMPLETE_TAIL_WITNESS_BYTES: usize = 64;
const MAX_CACHED_TRANSCRIPT_META_BYTES: usize = 64 * 1024 * 1024;
const CACHED_TRANSCRIPT_META_ABSENCE_TTL_MS: i64 = 48 * 60 * 60 * 1_000;
const SPAN_CONTEXT_TTL_MS: i64 = 48 * 60 * 60 * 1_000;
const SPAN_CONTEXT_CLEANUP_INTERVAL_MS: i64 = 5 * 60 * 1_000;
const WAKEUP_MARKER_CLEANUP_INTERVAL_MS: i64 = 5 * 60 * 1_000;
const MAX_WAKEUP_RESOURCE_ATTRIBUTE_VALUE_LENGTH: usize = 512;
const MAX_SPAN_ATTRIBUTE_VALUE_LENGTH: usize = 512;
const WAKEUP_RESOURCE_ATTRIBUTE_KEYS: &[&str] =
    &["agentteams.worker.name", "agentteams.instance.id"];

static SENSITIVE_SPAN_ATTRIBUTE_NAME_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)(^|[_.-])(TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE)([_.-]|$)|^(API_KEY|API_HEADER)$",
    )
    .expect("sensitive span attribute")
});

pub(super) struct CodexTranscriptEngine<'a> {
    pub body: &'a CodexTranscriptBody,
}

enum RecoveryKind {
    Unparseable,
    ProcessedEmpty,
    ProcessedEmitted,
}

struct Diagnostics {
    source_record_count: usize,
}

struct Recovery {
    kind: RecoveryKind,
    entries: Vec<AgentActivityEntry>,
    consumed_end_offset: i64,
    diagnostics: Diagnostics,
}

struct RecoveryBoundary {
    end_offset: i64,
    terminal: bool,
    inferred: Option<CodexTerminalStatus>,
    next_turn_started_at_ms: Option<f64>,
}

#[derive(Default)]
struct ScannedBoundary {
    terminal_turn_id: Option<String>,
    terminal_end: Option<i64>,
    next_turn_started_at_ms: Option<f64>,
}

struct PendingRecovery {
    blocked: bool,
    emitted_count: usize,
    processed_terminal_count: usize,
}

pub(super) fn has_copied_history_prefix(meta: Option<&CodexTranscriptMeta>) -> bool {
    meta.is_some_and(|meta| {
        meta.forked_from_id.is_some()
            || meta.parent_thread_id.is_some()
            || meta.thread_source == CodexThreadSource::Subagent
    })
}

impl<'a> CodexTranscriptEngine<'a> {
    fn remember_incomplete_tail(&self, path: &str, tail: scan::IncompleteJsonlTail) {
        self.body.with_shared(|shared| {
            shared.incomplete_tails.shift_remove(path);
            shared.incomplete_tails.insert(path.to_owned(), tail);
            while shared.incomplete_tails.len() > MAX_CACHED_INCOMPLETE_TAILS {
                shared.incomplete_tails.shift_remove_index(0);
            }
        });
    }
    async fn incomplete_tail_ready(
        &self,
        rt: &InputRuntime,
        path: &str,
        start: i64,
    ) -> anyhow::Result<bool> {
        let Some(tail) = self
            .body
            .with_shared(|shared| shared.incomplete_tails.shift_remove(path))
        else {
            return Ok(true);
        };
        let current = scan::file_version_snapshot(path).await?;
        if tail.start_offset != start
            || current.inode != tail.version.inode
            || current.device != tail.version.device
            || current.size < tail.version.size
            || (current.size == tail.version.size
                && (current.modified != tail.version.modified
                    || current.changed != tail.version.changed))
        {
            return Ok(true);
        }
        if current.size == tail.end_offset {
            if current.modified != tail.version.modified || current.changed != tail.version.changed
            {
                return Ok(true);
            }
            self.remember_incomplete_tail(path, tail);
            return Ok(false);
        }
        let mut file = tokio::fs::File::open(path).await?;
        if scan::opened_file_version(&file).await? != current {
            return Ok(true);
        }
        async fn read(
            file: &mut tokio::fs::File,
            position: i64,
            length: usize,
            rt: &InputRuntime,
        ) -> std::io::Result<Vec<u8>> {
            use tokio::io::{AsyncReadExt, AsyncSeekExt};
            file.seek(std::io::SeekFrom::Start(position as u64)).await?;
            let mut bytes = vec![0u8; length];
            let started = crate::inputs::base::InputRuntimeAccumulator::now();
            let n = file.read(&mut bytes).await?;
            rt.with_accumulator(|a| {
                a.observe_read(
                    n as u64,
                    length as u64,
                    crate::inputs::base::InputRuntimeAccumulator::now() - started,
                )
            });
            bytes.truncate(n);
            Ok(bytes)
        }
        let anchor = read(
            &mut file,
            tail.end_offset - tail.anchor.len() as i64,
            tail.anchor.len(),
            rt,
        )
        .await?;
        if anchor != tail.anchor {
            return Ok(true);
        }
        let mut position = tail.end_offset;
        let mut last = anchor;
        let search_end = current
            .size
            .min(position.saturating_add(MAX_SCAN_BYTES_PER_FILE_CYCLE));
        while position < search_end {
            let bytes = read(
                &mut file,
                position,
                ((search_end - position) as usize).min(scan::READ_CHUNK_SIZE),
                rt,
            )
            .await?;
            if bytes.is_empty() || bytes.contains(&b'\n') {
                return Ok(true);
            }
            position += bytes.len() as i64;
            if bytes.len() >= INCOMPLETE_TAIL_WITNESS_BYTES {
                last = bytes[bytes.len() - INCOMPLETE_TAIL_WITNESS_BYTES..].to_vec();
            } else {
                last.extend_from_slice(&bytes);
                if last.len() > INCOMPLETE_TAIL_WITNESS_BYTES {
                    last.drain(..last.len() - INCOMPLETE_TAIL_WITNESS_BYTES);
                }
            }
        }
        if scan::opened_file_version(&file).await? == current
            && scan::file_version_snapshot(path).await? == current
        {
            self.remember_incomplete_tail(
                path,
                scan::IncompleteJsonlTail {
                    start_offset: tail.start_offset,
                    end_offset: position,
                    anchor: last,
                    version: current,
                },
            );
        }
        Ok(false)
    }

    pub fn discard_legacy_global_turn_registry(&self, rt: &InputRuntime) {
        let current = rt.state_store.get("codex-transcript");
        let Some(mut extra) = current.extra() else {
            return;
        };
        let Some(object) = extra.as_object_mut() else {
            return;
        };
        if object.remove("codexTranscriptGlobal").is_none() {
            return;
        }
        rt.state_store
            .set("codex-transcript", current.with_extra(extra));
    }

    pub fn state_key(&self, file_path: &str) -> String {
        format!("codex-transcript:{file_path}")
    }

    pub fn read_checkpoint(
        &self,
        rt: &InputRuntime,
        key: &str,
    ) -> Option<CodexTranscriptCheckpoint> {
        let extra = rt.state_store.get(key).extra()?;
        parse_checkpoint(extra.get("codexTranscript")?)
    }

    pub fn save_checkpoint(
        &self,
        rt: &InputRuntime,
        key: &str,
        checkpoint: &CodexTranscriptCheckpoint,
    ) {
        self.save_delegation_state(rt);
        rt.state_store.update(
            key,
            InputStatePatch {
                last_offset: Some(checkpoint.scan_offset as f64),
                extra: Some(json!({ "codexTranscript": checkpoint_to_value(checkpoint) })),
                ..InputStatePatch::default()
            },
        );
    }

    pub async fn discover_session_files(&self) -> Vec<DiscoveredSessionFile> {
        #[cfg(test)]
        self.body.with_shared(|s| s.main541_discoveries += 1);
        let canonical_default = canonical_directory_path(&self.body.session_dir).await;
        let default_files = self.list_default_rollout_files().await;
        let mut discovered: IndexMap<String, DiscoveredSessionFile> = IndexMap::new();
        for file_path in default_files {
            let relative = path_relative(&self.body.session_dir, &file_path);
            let canonical_path = if relative.is_empty() {
                canonical_default.clone()
            } else {
                Path::new(&canonical_default)
                    .join(relative)
                    .to_string_lossy()
                    .into_owned()
            };
            discovered.insert(
                canonical_path,
                DiscoveredSessionFile {
                    file_path,
                    baseline_on_start: true,
                },
            );
        }
        let mut remaining = MAX_DYNAMIC_SESSION_FILES;
        for session_dir in self.discover_dynamic_session_dirs(&canonical_default).await {
            if remaining == 0 {
                break;
            }
            let mut files = Vec::new();
            let mut budget = WalkBudget {
                remaining_directories: MAX_DYNAMIC_DIRECTORIES_PER_ROOT,
                remaining_rollout_files: MAX_DYNAMIC_ROLLOUT_FILES_PER_ROOT,
            };
            collect_recent_rollout_files(
                &session_dir,
                &mut files,
                (now_ms() as i64) - DYNAMIC_SESSION_FILE_MAX_IDLE_MS,
                remaining,
                &mut budget,
                0,
            )
            .await;
            for file_path in files {
                if discovered.contains_key(&file_path) {
                    continue;
                }
                discovered.insert(
                    file_path.clone(),
                    DiscoveredSessionFile {
                        file_path,
                        baseline_on_start: false,
                    },
                );
                remaining -= 1;
                if remaining == 0 {
                    break;
                }
            }
        }
        let mut files: Vec<DiscoveredSessionFile> = discovered.into_values().collect();
        files.sort_by(|left, right| left.file_path.cmp(&right.file_path));
        files
    }

    async fn list_default_rollout_files(&self) -> Vec<String> {
        let cached = self.body.with_shared(|shared| {
            shared
                .cached_default
                .as_ref()
                .map(|cached| (cached.dir_mtimes.clone(), cached.files.clone()))
        });
        if let Some((dir_mtimes, files)) = cached {
            if rollout_dirs_unchanged(&dir_mtimes).await {
                return files;
            }
        }
        let mut files = Vec::new();
        let mut dir_mtimes = Vec::new();
        let complete =
            collect_rollout_files(&self.body.session_dir, &mut files, &mut dir_mtimes).await;
        if !complete {
            crate::utils::create_logger("CodexTranscriptInput").warn(
                "Codex rollout directory scan failed; retrying next poll",
                None,
            );
        }
        self.body.with_shared(|shared| {
            shared.cached_default = if !complete || dir_mtimes.is_empty() {
                None
            } else {
                Some(super::CachedDefault {
                    dir_mtimes,
                    files: files.clone(),
                })
            };
        });
        files
    }

    pub fn historical_skip_paths(
        &self,
        files: &[DiscoveredSessionFile],
        now: i64,
    ) -> HashSet<String> {
        let refresh = self.body.with_shared(|shared| {
            if now - shared.last_historical_stat_at >= super::HISTORICAL_ROLLOUT_RECHECK_MS {
                shared.last_historical_stat_at = now;
                true
            } else {
                false
            }
        });
        if refresh {
            return HashSet::new();
        }
        let mut skip = HashSet::new();
        self.body.with_shared(|shared| {
            for file in files {
                if !file.baseline_on_start {
                    continue;
                }
                let Some(snap) = shared.idle.get(&file.file_path) else {
                    continue;
                };
                if now - snap.mtime_ms < DYNAMIC_SESSION_FILE_MAX_IDLE_MS {
                    continue;
                }
                skip.insert(file.file_path.clone());
            }
        });
        skip
    }

    fn note_rollout_idle(&self, rt: &InputRuntime, file_path: &str, stat: Option<RolloutStat>) {
        let Some(stat) = stat else {
            self.body.with_shared(|shared| {
                shared.idle.shift_remove(file_path);
            });
            return;
        };
        let caught_up = self
            .read_checkpoint(rt, &self.state_key(file_path))
            .is_some_and(|checkpoint| rollout_caught_up(&checkpoint, stat.ino, stat.size));
        self.body.with_shared(|shared| {
            if caught_up {
                shared.idle.insert(file_path.to_owned(), stat);
            } else {
                shared.idle.shift_remove(file_path);
            }
        });
    }

    pub async fn process_file(&self, rt: &InputRuntime, file_path: &str) -> anyhow::Result<usize> {
        #[cfg(test)]
        self.body
            .with_shared(|s| s.main541_visits.push(file_path.to_owned()));
        let stat = match file_meta_snapshot(file_path).await {
            Ok((ino, size, mtime_ms)) => Some(RolloutStat {
                ino,
                size,
                mtime_ms,
            }),
            Err(_) => None,
        };
        let result = match stat {
            Some(stat) => {
                let key = self.state_key(file_path);
                if self.read_checkpoint(rt, &key).is_none()
                    && rt.state_store.get(&key).last_offset().is_none()
                {
                    // Persist body-free ownership before the first native output.
                    // Failure propagates; the canonical ACK checkpoint stays untouched.
                    super::source_ownership::remember(&self.body.wakeup_dir, file_path).await?;
                }
                self.scan_rollout_file(rt, file_path, stat).await
            }
            None => Ok(0),
        };
        self.note_rollout_idle(rt, file_path, stat);
        result
    }

    async fn scan_rollout_file(
        &self,
        rt: &InputRuntime,
        file_path: &str,
        stat: RolloutStat,
    ) -> anyhow::Result<usize> {
        let key = self.state_key(file_path);
        let indexed = self
            .body
            .with_shared(|shared| shared.meta_by_path.get(file_path).cloned());
        let has_indexed_copied = has_copied_history_prefix(indexed.as_ref());
        let mut checkpoint = self.read_checkpoint(rt, &key);
        let mut changed = false;
        if checkpoint.is_none() {
            checkpoint = Some(empty_checkpoint(stat.ino));
            changed = true;
        }
        let mut checkpoint = checkpoint.expect("checkpoint");
        if checkpoint.inode != stat.ino {
            let bootstrap = checkpoint.fork_bootstrap.clone();
            if has_indexed_copied
                && bootstrap
                    .as_ref()
                    .is_some_and(|item| item.state == ForkBootstrapState::LivePending)
            {
                let meta = json!({
                    "transcriptPath": file_path,
                    "previousInode": checkpoint.inode,
                    "currentInode": stat.ino,
                    "previousScanOffset": checkpoint.scan_offset,
                    "previousSearchOffset": bootstrap.as_ref().map(|item| item.search_offset).unwrap_or(0),
                });
                rt.warn(
                    "Codex fork transcript inode changed before owned history was consumed; restarting bootstrap",
                    meta.as_object(),
                );
                let mut next = empty_checkpoint(stat.ino);
                if let Some(mut bootstrap) = bootstrap {
                    bootstrap.state = ForkBootstrapState::LivePending;
                    bootstrap.search_offset = 0;
                    next.fork_bootstrap = Some(bootstrap);
                }
                checkpoint = next;
                changed = true;
            } else {
                let meta = json!({
                    "transcriptPath": file_path,
                    "previousInode": checkpoint.inode,
                    "currentInode": stat.ino,
                    "previousScanOffset": checkpoint.scan_offset,
                    "hadForkBootstrap": checkpoint.fork_bootstrap.is_some(),
                    "hasCopiedPrefix": has_indexed_copied,
                });
                rt.warn(
                    "Codex transcript inode changed; applying no-replay baseline",
                    meta.as_object(),
                );
                if has_indexed_copied {
                    self.park_fork_baseline(rt, file_path, &key).await?;
                } else {
                    self.baseline_file(rt, file_path, &key).await?;
                }
                return Ok(0);
            }
        }
        let backlog = (stat.size - checkpoint.scan_offset).max(0) as u64;
        scan::observe_backlog(rt, backlog);
        if rollout_caught_up(&checkpoint, stat.ino, stat.size) {
            return Ok(0);
        }
        let version = scan::file_version_snapshot(file_path).await?;
        if version.inode != stat.ino || version.size != stat.size {
            return Ok(0);
        }
        if checkpoint
            .owner_session_meta_offset
            .is_some_and(|offset| offset >= stat.size)
        {
            checkpoint.owner_session_meta_offset = None;
            changed = true;
        }
        if checkpoint.owner_session_meta_offset.is_none() {
            if let Some(offset) = self
                .find_owner_offset(rt, file_path, &version, None)
                .await?
            {
                checkpoint.owner_session_meta_offset = Some(offset);
                changed = true;
            }
        }
        let active_access = checkpoint.scan_offset < stat.size
            || checkpoint.active_turn.is_some()
            || checkpoint.pending_terminal.is_some()
            || checkpoint.pending_fusion.is_some()
            || checkpoint.pending_subagent.is_some()
            || checkpoint
                .fork_bootstrap
                .as_ref()
                .is_some_and(|item| item.state == ForkBootstrapState::LivePending);
        self.register_subagent_owner_meta(
            rt,
            file_path,
            checkpoint.inode,
            stat.size,
            checkpoint.owner_session_meta_offset,
            active_access,
        )
        .await?;
        let owner_meta = self
            .body
            .with_shared(|shared| shared.meta_by_path.get(file_path).cloned());
        let is_direct_subagent = owner_meta
            .as_ref()
            .is_some_and(|meta| meta.thread_source == CodexThreadSource::Subagent);
        if owner_meta.is_some() {
            if let Some(thread_id) = owner_meta.as_ref().map(|meta| meta.thread_id.clone()) {
                self.register_persisted_subagent_spawns(&checkpoint, &thread_id);
            }
        }
        if has_copied_history_prefix(owner_meta.as_ref())
            && checkpoint.active_turn.is_none()
            && checkpoint.pending_terminal.is_none()
        {
            if let Some(meta) = owner_meta.clone() {
                let prepared = self
                    .prepare_copied_transcript(rt, file_path, stat.size, &meta, &mut checkpoint)
                    .await?;
                changed |= prepared.changed;
                if !prepared.ready {
                    if changed {
                        self.save_checkpoint(rt, &key, &checkpoint);
                    } else {
                        self.save_delegation_state(rt);
                    }
                    return Ok(0);
                }
            }
        }
        let fork_at_start = checkpoint.fork_bootstrap.clone();
        let owned_scan_start = checkpoint.scan_offset;
        let mut emitted_count = 0usize;
        let mut processed_terminals = 0usize;
        if is_direct_subagent
            && checkpoint.pending_terminal.is_some()
            && checkpoint.active_turn.as_ref().is_some_and(|active| {
                checkpoint
                    .pending_terminal
                    .as_ref()
                    .is_some_and(|pending| active.turn_id == pending.turn_id)
            })
            && should_skip_copied_parent_turn(
                checkpoint
                    .pending_terminal
                    .as_ref()
                    .map(|pending| pending.turn_id.as_str())
                    .unwrap_or(""),
                checkpoint
                    .active_turn
                    .as_ref()
                    .map(|active| active.started_at_ms)
                    .unwrap_or(0.0),
                owner_meta.as_ref().and_then(|meta| meta.created_at_ms),
            )
        {
            checkpoint.active_turn = None;
            checkpoint.pending_terminal = None;
            processed_terminals += 1;
            changed = true;
        }
        // Replay legacy retained ranges independently. Only a child's own native
        // terminal can finish it; the parent's terminal is never borrowed.
        if checkpoint.pending_subagent.is_some() {
            let released = self
                .release_captured_subagent_independently(rt, file_path, &mut checkpoint)
                .await?;
            emitted_count += released.0;
            processed_terminals += released.1;
            changed = true;
            if checkpoint.pending_subagent.is_some() {
                self.save_checkpoint(rt, &key, &checkpoint);
                return Ok(emitted_count);
            }
        }
        if checkpoint.pending_fusion.is_some() {
            let released = self
                .release_parent_fusion_independently(rt, file_path, &mut checkpoint)
                .await?;
            emitted_count += released.0;
            processed_terminals += released.1;
            changed = true;
        }

        let mut scanned_bytes = 0i64;
        let deferred = self
            .recover_deferred_terminals(rt, file_path, &mut checkpoint, &version)
            .await?;
        changed |= deferred.changed;
        emitted_count += deferred.emitted_count;
        processed_terminals += deferred.processed_terminal_count;
        let prior_pending = checkpoint.pending_terminal.clone();
        let pending = self
            .recover_pending_terminal(rt, file_path, &mut checkpoint, &version)
            .await?;
        #[cfg(test)]
        self.body.with_shared(|shared| {
            shared
                .main543_pending_results
                .push((pending.blocked, pending.processed_terminal_count))
        });
        changed |= checkpoint.pending_terminal != prior_pending;
        emitted_count += pending.emitted_count;
        processed_terminals += pending.processed_terminal_count;
        if pending.blocked {
            if changed {
                self.save_checkpoint(rt, &key, &checkpoint);
            }
            return Ok(emitted_count);
        }

        while checkpoint.scan_offset < stat.size
            && processed_terminals < MAX_TERMINALS_PER_FILE_CYCLE
            && scanned_bytes < MAX_SCAN_BYTES_PER_FILE_CYCLE
        {
            if !self
                .incomplete_tail_ready(rt, file_path, checkpoint.scan_offset)
                .await?
            {
                break;
            }
            let scan_start = checkpoint.scan_offset;
            let scan_end = stat
                .size
                .min(scan_start + (MAX_SCAN_BYTES_PER_FILE_CYCLE - scanned_bytes));
            let mut scanned_boundary = ScannedBoundary::default();
            let mut scan = scan_json_lines(file_path, scan_start, scan_end, Some(rt), |line| {
                process_scanned_line(
                    &mut checkpoint,
                    file_path,
                    stat.size,
                    &line,
                    &mut scanned_boundary,
                    self,
                )
            })
            .await?;
            if scan.next_offset == scan_start && scan_end < stat.size {
                scan = scan_json_lines(file_path, scan_start, stat.size, Some(rt), |line| {
                    process_scanned_line(
                        &mut checkpoint,
                        file_path,
                        stat.size,
                        &line,
                        &mut scanned_boundary,
                        self,
                    );
                    false
                })
                .await?;
            }
            if let Some(tail) = scan
                .incomplete_tail
                .take()
                .filter(|tail| tail.end_offset == stat.size)
            {
                if scan::file_version_snapshot(file_path).await? == tail.version {
                    self.remember_incomplete_tail(file_path, tail);
                }
            }
            if scan.next_offset == scan_start {
                break;
            }
            changed = true;
            let ScannedBoundary {
                terminal_turn_id,
                terminal_end,
                next_turn_started_at_ms,
            } = scanned_boundary;
            let deferred_turn_start = next_turn_started_at_ms.is_some();
            let next_scan_offset = terminal_end.unwrap_or(scan.next_offset);
            scan::observe_batch(
                rt,
                CommittedInputBatch {
                    bytes: (next_scan_offset - scan_start).max(0) as u64,
                    records: scan.records.saturating_sub(u64::from(deferred_turn_start)),
                    parse_success_records: scan
                        .parse_success_records
                        .saturating_sub(u64::from(deferred_turn_start)),
                    parse_failed_records: scan.parse_failed_records,
                    max_record_bytes: scan.max_record_bytes,
                },
            );
            scanned_bytes += next_scan_offset - scan_start;
            let mut blocked = false;
            if checkpoint.active_turn.as_ref().is_some_and(|active| {
                terminal_turn_id.is_some() || next_scan_offset > active.start_offset
            }) {
                if is_direct_subagent
                    && terminal_turn_id.is_some()
                    && should_skip_copied_parent_turn(
                        terminal_turn_id.as_deref().unwrap_or(""),
                        checkpoint
                            .active_turn
                            .as_ref()
                            .map(|active| active.started_at_ms)
                            .unwrap_or(0.0),
                        owner_meta.as_ref().and_then(|meta| meta.created_at_ms),
                    )
                {
                    checkpoint.active_turn = None;
                    processed_terminals += 1;
                    checkpoint.scan_offset = next_scan_offset;
                    continue;
                }
                let recovered = self
                    .recover_turn_segment(
                        rt,
                        file_path,
                        &mut checkpoint,
                        RecoveryBoundary {
                            end_offset: next_scan_offset,
                            terminal: terminal_turn_id.is_some(),
                            inferred: next_turn_started_at_ms
                                .map(|_| CodexTerminalStatus::Interrupted),
                            next_turn_started_at_ms,
                        },
                        None,
                    )
                    .await?;
                emitted_count += self.body.emit_batches(recovered.entries);
                if !matches!(recovered.kind, RecoveryKind::Unparseable)
                    && checkpoint
                        .active_turn
                        .as_ref()
                        .is_some_and(|active| recovered.consumed_end_offset > active.start_offset)
                {
                    if let Some(active) = checkpoint.active_turn.as_mut() {
                        active.start_offset = recovered.consumed_end_offset;
                    }
                }
                if terminal_turn_id.is_some()
                    && checkpoint.active_turn.as_ref().is_some_and(|active| {
                        Some(active.turn_id.as_str()) == terminal_turn_id.as_deref()
                    })
                {
                    if matches!(recovered.kind, RecoveryKind::Unparseable) {
                        let turn_id = terminal_turn_id.clone().unwrap_or_default();
                        let start = checkpoint
                            .active_turn
                            .as_ref()
                            .map(|active| active.start_offset)
                            .unwrap_or(0);
                        let now = self.recovery_now_ms();
                        let mut pending = new_pending_terminal_at(
                            turn_id,
                            next_scan_offset,
                            recovered.diagnostics.source_record_count as u64,
                            now,
                        );
                        self.note_terminal_failure(&mut pending, &version, now);
                        checkpoint.pending_terminal = Some(pending.clone());
                        let deferred = Self::defer_pending_terminal(&mut checkpoint);
                        self.log_terminal_failure(
                            rt,
                            file_path,
                            &checkpoint,
                            &pending,
                            TerminalFailureContext {
                                start_offset: start,
                                phase: "terminal",
                                deferred,
                            },
                        );
                        blocked = !deferred;
                        processed_terminals += 1;
                    } else if checkpoint.pending_fusion.is_none() {
                        checkpoint.active_turn = None;
                        checkpoint.pending_terminal = None;
                        processed_terminals += 1;
                    } else {
                        // A deferred start may have zero byte progress. Let the
                        // existing pending recovery resolve before scanning it again.
                        blocked = true;
                    }
                }
            }
            checkpoint.scan_offset = next_scan_offset;
            if blocked || terminal_turn_id.is_none() {
                break;
            }
        }
        if fork_at_start.is_some() && checkpoint.scan_offset > owned_scan_start {
            checkpoint.fork_bootstrap = None;
            changed = true;
        }
        if changed {
            self.save_checkpoint(rt, &key, &checkpoint);
        }
        Ok(emitted_count)
    }
}

fn process_scanned_line(
    checkpoint: &mut CodexTranscriptCheckpoint,
    file_path: &str,
    file_size: i64,
    line: &JsonLine,
    boundary: &mut ScannedBoundary,
    engine: &CodexTranscriptEngine<'_>,
) -> bool {
    let Some(payload) = line.record.get("payload").and_then(Value::as_object) else {
        return true;
    };
    if line.record.get("type").and_then(Value::as_str) == Some("session_meta") {
        let owner =
            select_owner_session_meta_offset(file_path, checkpoint.owner_session_meta_offset, line);
        checkpoint.owner_session_meta_offset = owner;
        if owner == Some(line.start_offset) {
            if let Some(meta) = extract_codex_transcript_meta(&line.record) {
                engine.remember_transcript_owner_meta(
                    file_path,
                    checkpoint.inode,
                    file_size,
                    line.start_offset,
                    meta.clone(),
                    true,
                );
                engine.publish_transcript_owner_meta(file_path, meta);
            }
        }
        return true;
    }
    if let Some(turn_id) = turn_id_for_start(&line.record, payload) {
        if let Some(active) = checkpoint
            .active_turn
            .as_ref()
            .filter(|active| active.turn_id != turn_id)
        {
            // This start belongs to the next turn. Recover the old turn before
            // replacing its retained ordinary steps, then revisit this same line.
            boundary.terminal_turn_id = Some(active.turn_id.clone());
            boundary.terminal_end = Some(line.start_offset);
            boundary.next_turn_started_at_ms = Some(utils::timestamp_ms(&line.record, now_ms()));
            return false;
        }
        if checkpoint.active_turn.is_none() {
            if checkpoint.first_owned_turn_id.is_none() {
                checkpoint.first_owned_turn_id = Some(turn_id.clone());
            }
            checkpoint.active_turn = Some(create_active_turn(
                turn_id.clone(),
                line.start_offset,
                utils::timestamp_ms(&line.record, now_ms()),
                false,
            ));
        }
        if let Some(active) = checkpoint.active_turn.as_mut() {
            update_active_turn_metadata(active, &line.record, payload);
        }
        return true;
    }
    if let Some(terminal) = terminal_turn_id_for(&line.record, payload) {
        if checkpoint
            .active_turn
            .as_ref()
            .is_some_and(|active| active.turn_id == terminal)
        {
            boundary.terminal_turn_id = Some(terminal);
            boundary.terminal_end = Some(line.end_offset);
            return false;
        }
    }
    true
}

use indexmap::IndexMap;

fn path_relative(from: &str, to: &str) -> String {
    match Path::new(to).strip_prefix(Path::new(from)) {
        Ok(relative) => relative.to_string_lossy().into_owned(),
        Err(_) => String::new(),
    }
}

async fn rollout_dirs_unchanged(dir_mtimes: &[(String, i64)]) -> bool {
    if dir_mtimes.is_empty() {
        return false;
    }
    for (dir, mtime) in dir_mtimes {
        match tokio::fs::metadata(dir).await {
            Ok(meta) => {
                if directory_mtime(&meta) != Some(*mtime) {
                    return false;
                }
            }
            Err(_) => return false,
        }
    }
    true
}

fn rollout_caught_up(checkpoint: &CodexTranscriptCheckpoint, ino: u64, size: i64) -> bool {
    checkpoint.inode == ino
        && checkpoint.scan_offset >= size
        && checkpoint.owner_session_meta_offset.is_some()
        && checkpoint.active_turn.is_none()
        && checkpoint.pending_terminal.is_none()
        && checkpoint.deferred_terminals.is_empty()
        && checkpoint.pending_fusion.is_none()
        && checkpoint.pending_subagent.is_none()
        && checkpoint.fork_bootstrap.is_none()
}

fn should_skip_copied_parent_turn(
    turn_id: &str,
    observed_started_at_ms: f64,
    owner_created_at_ms: Option<f64>,
) -> bool {
    let Some(owner_created_at_ms) = owner_created_at_ms else {
        return false;
    };
    uuid_v7_timestamp_ms(turn_id).unwrap_or(observed_started_at_ms) < owner_created_at_ms
}

impl<'a> CodexTranscriptEngine<'a> {
    fn recovery_now_ms(&self) -> f64 {
        #[cfg(test)]
        if let Some(clock) = self.body.with_shared(|shared| shared.main543_clock.clone()) {
            return clock().floor();
        }
        now_ms().floor()
    }
    fn terminal_retry_ready(
        &self,
        pending: &CodexPendingTerminalTurn,
        version: &scan::FileVersion,
    ) -> bool {
        pending.failure.as_ref().is_none_or(|failure| {
            failure.source_version != source_version(version)
                && self.recovery_now_ms() >= failure.retry_at_ms
        })
    }
    fn note_terminal_failure(
        &self,
        pending: &mut CodexPendingTerminalTurn,
        version: &scan::FileVersion,
        now: f64,
    ) {
        let delay = pending
            .failure
            .as_ref()
            .map(|failure| failure.delay_ms)
            .unwrap_or(RECOVERY_RETRY_MIN_MS / 2)
            .saturating_mul(2)
            .clamp(RECOVERY_RETRY_MIN_MS, RECOVERY_RETRY_MAX_MS);
        pending.failure = Some(CodexTerminalRecoveryFailure {
            source_version: source_version(version),
            retry_at_ms: now + delay as f64,
            delay_ms: delay,
        });
    }
    fn defer_pending_terminal(checkpoint: &mut CodexTranscriptCheckpoint) -> bool {
        if checkpoint.active_turn.is_none()
            || checkpoint.pending_terminal.is_none()
            || checkpoint.deferred_terminals.len() >= MAX_DEFERRED_TERMINALS
        {
            return false;
        }
        let active_turn = checkpoint.active_turn.take().expect("checked active");
        let pending_terminal = checkpoint.pending_terminal.take().expect("checked pending");
        checkpoint.scan_offset = checkpoint
            .scan_offset
            .max(pending_terminal.terminal_end_offset);
        checkpoint
            .deferred_terminals
            .push(CodexDeferredTerminalTurn {
                active_turn,
                pending_terminal,
            });
        true
    }
    fn log_terminal_failure(
        &self,
        rt: &InputRuntime,
        file_path: &str,
        checkpoint: &CodexTranscriptCheckpoint,
        pending: &CodexPendingTerminalTurn,
        context: TerminalFailureContext,
    ) {
        let TerminalFailureContext {
            start_offset,
            phase,
            deferred,
        } = context;
        let mut meta = json!({
            "transcriptPath": file_path, "turnId": pending.turn_id, "recoveryPhase": phase,
            "range": {"startOffset": start_offset, "endOffset": pending.terminal_end_offset},
            "retryCount": pending.retry_count.unwrap_or(0), "firstPendingAtMs": pending.first_pending_at_ms,
            "lastAttemptAtMs": pending.last_attempt_at_ms, "sourceRecordCount": pending.source_record_count.unwrap_or(0),
            "retryDelayMs": pending.failure.as_ref().map(|failure| failure.delay_ms),
            "deferred": deferred, "deferredRanges": checkpoint.deferred_terminals.len(),
            "deferredLimit": MAX_DEFERRED_TERMINALS, "blocked": checkpoint.pending_terminal.is_some(),
        });
        if let Some(blocking) = &checkpoint.pending_terminal {
            meta["blockingTurnId"] = json!(blocking.turn_id);
        }
        const MESSAGE: &str = "Codex terminal turn could not be parsed; retained until source changes and backoff expires";
        #[cfg(test)]
        if let Some(observer) = self
            .body
            .with_shared(|shared| shared.main543_failure_observer.clone())
        {
            observer(MESSAGE, &meta);
        }
        rt.warn(MESSAGE, meta.as_object());
    }
    async fn recover_deferred_terminals(
        &self,
        rt: &InputRuntime,
        file_path: &str,
        checkpoint: &mut CodexTranscriptCheckpoint,
        version: &scan::FileVersion,
    ) -> anyhow::Result<DeferredRecovery> {
        let Some(index) = checkpoint
            .deferred_terminals
            .iter()
            .position(|item| self.terminal_retry_ready(&item.pending_terminal, version))
        else {
            return Ok(DeferredRecovery {
                changed: false,
                emitted_count: 0,
                processed_terminal_count: 0,
            });
        };
        let item = checkpoint.deferred_terminals[index].clone();
        let mut recovery = checkpoint.clone();
        recovery.active_turn = Some(item.active_turn.clone());
        recovery.pending_terminal = Some(item.pending_terminal.clone());
        let recovered = self
            .recover_turn_segment(
                rt,
                file_path,
                &mut recovery,
                RecoveryBoundary {
                    end_offset: item.pending_terminal.terminal_end_offset,
                    terminal: true,
                    inferred: None,
                    next_turn_started_at_ms: None,
                },
                None,
            )
            .await?;
        let emitted_count = if matches!(recovered.kind, RecoveryKind::Unparseable) {
            let now = self.recovery_now_ms();
            let mut pending = item.pending_terminal;
            pending.retry_count = Some(
                pending
                    .retry_count
                    .unwrap_or(0)
                    .saturating_add(1)
                    .min(MAX_SAFE_INTEGER),
            );
            pending.first_pending_at_ms = Some(pending.first_pending_at_ms.unwrap_or(now));
            pending.last_attempt_at_ms = Some(now);
            pending.source_record_count = Some(recovered.diagnostics.source_record_count as u64);
            self.note_terminal_failure(&mut pending, version, now);
            checkpoint.deferred_terminals[index].pending_terminal = pending.clone();
            self.log_terminal_failure(
                rt,
                file_path,
                checkpoint,
                &pending,
                TerminalFailureContext {
                    start_offset: item.active_turn.start_offset,
                    phase: "deferred",
                    deferred: true,
                },
            );
            0
        } else {
            checkpoint.deferred_terminals.remove(index);
            self.body.emit_batches(recovered.entries)
        };
        Ok(DeferredRecovery {
            changed: true,
            emitted_count,
            processed_terminal_count: 1,
        })
    }
    async fn recover_pending_terminal(
        &self,
        rt: &InputRuntime,
        file_path: &str,
        checkpoint: &mut CodexTranscriptCheckpoint,
        version: &scan::FileVersion,
    ) -> anyhow::Result<PendingRecovery> {
        let Some(mut pending) = checkpoint.pending_terminal.clone() else {
            return Ok(PendingRecovery {
                blocked: false,
                emitted_count: 0,
                processed_terminal_count: 0,
            });
        };
        if checkpoint
            .active_turn
            .as_ref()
            .is_none_or(|active| active.turn_id != pending.turn_id)
        {
            checkpoint.pending_terminal = None;
            return Ok(PendingRecovery {
                blocked: false,
                emitted_count: 0,
                processed_terminal_count: 0,
            });
        }
        if !self.terminal_retry_ready(&pending, version) {
            let deferred = Self::defer_pending_terminal(checkpoint);
            return Ok(PendingRecovery {
                blocked: !deferred,
                emitted_count: 0,
                processed_terminal_count: 0,
            });
        }
        let recovered = self
            .recover_turn_segment(
                rt,
                file_path,
                checkpoint,
                RecoveryBoundary {
                    end_offset: pending.terminal_end_offset,
                    terminal: true,
                    inferred: None,
                    next_turn_started_at_ms: None,
                },
                None,
            )
            .await?;
        if matches!(recovered.kind, RecoveryKind::Unparseable) {
            let now = self.recovery_now_ms();
            pending.retry_count = Some(
                pending
                    .retry_count
                    .unwrap_or(0)
                    .saturating_add(1)
                    .min(MAX_SAFE_INTEGER),
            );
            pending.first_pending_at_ms = Some(pending.first_pending_at_ms.unwrap_or(now));
            pending.last_attempt_at_ms = Some(now);
            pending.source_record_count = Some(recovered.diagnostics.source_record_count as u64);
            self.note_terminal_failure(&mut pending, version, now);
            let start = checkpoint
                .active_turn
                .as_ref()
                .expect("retained active")
                .start_offset;
            checkpoint.pending_terminal = Some(pending.clone());
            let deferred = Self::defer_pending_terminal(checkpoint);
            self.log_terminal_failure(
                rt,
                file_path,
                checkpoint,
                &pending,
                TerminalFailureContext {
                    start_offset: start,
                    phase: "pending",
                    deferred,
                },
            );
            return Ok(PendingRecovery {
                blocked: !deferred,
                emitted_count: 0,
                processed_terminal_count: 1,
            });
        }
        let emitted_count = self.body.emit_batches(recovered.entries);
        checkpoint.active_turn = None;
        checkpoint.pending_terminal = None;
        Ok(PendingRecovery {
            blocked: false,
            emitted_count,
            processed_terminal_count: 1,
        })
    }

    async fn recover_turn_segment(
        &self,
        rt: &InputRuntime,
        file_path: &str,
        checkpoint: &mut CodexTranscriptCheckpoint,
        boundary: RecoveryBoundary,
        attachment_parent_thread_id: Option<&str>,
    ) -> anyhow::Result<Recovery> {
        #[cfg(test)]
        if let Some(observer) = self
            .body
            .with_shared(|shared| shared.main543_recovery_end_observer.clone())
        {
            observer(boundary.end_offset);
        }

        // Match the legacy contract's one-shot converter failure at the actual
        // recovery entry, without affecting any product build or filesystem IO.
        #[cfg(test)]
        if boundary.terminal
            && self
                .body
                .with_shared(|shared| std::mem::take(&mut shared.main543_force_terminal_failure))
        {
            return Ok(empty_unparseable(boundary.end_offset));
        }

        let RecoveryBoundary {
            end_offset,
            terminal,
            inferred,
            next_turn_started_at_ms,
        } = boundary;
        let Some(active) = checkpoint.active_turn.clone() else {
            return Ok(empty_unparseable(end_offset));
        };
        let records = read_json_lines(file_path, active.start_offset, end_offset, Some(rt)).await?;
        let current_stat = file_meta_snapshot(file_path).await.ok();
        let current_ino = current_stat.map(|(inode, _, _)| inode);
        let current_size = current_stat.map(|(_, size, _)| size);
        let mut meta = if current_ino == Some(checkpoint.inode) {
            current_size
                .and_then(|size| self.cached_meta_for_checkpoint(file_path, checkpoint, size))
        } else {
            None
        };
        if meta.is_none() {
            if let Some(offset) = checkpoint.owner_session_meta_offset {
                if let Some(record) = read_json_line_at(file_path, offset, Some(rt)).await? {
                    meta = extract_codex_transcript_meta(&record);
                    if let Some(meta) = meta.clone() {
                        if current_ino == Some(checkpoint.inode)
                            && current_size.is_some_and(|size| offset >= 0 && offset < size)
                        {
                            self.remember_transcript_owner_meta(
                                file_path,
                                checkpoint.inode,
                                current_size.unwrap_or(0),
                                offset,
                                meta.clone(),
                                true,
                            );
                        }
                        self.publish_transcript_owner_meta(file_path, meta);
                    }
                }
            }
        }
        let mut sources: Vec<CodexTranscriptSourceRecord> = records
            .items
            .iter()
            .map(|line| CodexTranscriptSourceRecord {
                start_offset: line.start_offset,
                end_offset: line.end_offset,
                record: line.record.clone(),
            })
            .collect();
        let upload_mode = self.body.upload_mode;
        let processor = self.body.processor.clone();
        let include = self.body.include_multimodal && processor.is_some();
        let blob = if include {
            Some(
                self.make_blob(
                    rt,
                    file_path,
                    active.cwd.as_deref(),
                    attachment_parent_thread_id
                        .or_else(|| {
                            active
                                .delegation
                                .as_ref()
                                .map(|link| link.parent_thread_id.as_str())
                        })
                        .or_else(|| {
                            meta.as_ref()
                                .and_then(|meta| meta.parent_thread_id.as_deref())
                        }),
                ),
            )
        } else {
            None
        };
        let blob_to_uri = blob.as_ref().map(blob_as_dyn);
        if let Some(next_start) = next_turn_started_at_ms {
            // Recovery-only evidence of interruption. It is not a source record,
            // is never persisted/counted, and carries no next-turn input.
            let timestamp = chrono::DateTime::from_timestamp_millis(next_start as i64)
                .unwrap_or_else(chrono::Utc::now)
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            sources.push(CodexTranscriptSourceRecord {
                start_offset: end_offset,
                end_offset,
                record: json!({"timestamp":timestamp,"type":"event_msg","payload":{"type":"turn_aborted","turn_id":active.turn_id}}).as_object().expect("recovery terminal").clone(),
            });
        }
        let extraction = extract_codex_partial_turn_with_boundaries(
            &sources,
            meta.as_ref(),
            &session_id_from_transcript_path(file_path),
            &active.turn_id,
            &ExtractOptions {
                require_terminal: false,
                started_at_ms: Some(active.started_at_ms),
                next_step_started_at_ms: active.next_step_started_at_ms,
                last_cumulative_token_total: active.last_cumulative_token_total,
                model: active.model.clone(),
                cwd: active.cwd.clone(),
                developer_instructions: active.developer_instructions.clone(),
                blob_to_uri,
                upload_mode: include.then_some(upload_mode),
            },
        );
        if next_turn_started_at_ms.is_some() {
            sources.pop();
        }
        let Some(mut extraction) = extraction else {
            return Ok(Recovery {
                kind: RecoveryKind::Unparseable,
                entries: Vec::new(),
                consumed_end_offset: active.start_offset,
                diagnostics: Diagnostics {
                    source_record_count: records.items.len(),
                },
            });
        };
        if let Some(status) = inferred {
            extraction.turn.status = status;
        }
        if let Some(slot) = checkpoint.active_turn.as_mut() {
            update_active_turn_from_extracted(
                slot,
                &extraction.turn.model,
                extraction.turn.cwd.as_deref(),
                extraction.turn.developer_instructions.as_deref(),
            );
        }
        if !extraction.turn.unmatched_token_usages.is_empty() {
            let meta = json!({
                "transcriptPath": file_path,
                "turnId": active.turn_id,
                "count": extraction.turn.unmatched_token_usages.len(),
            });
            rt.warn(
                "Codex transcript token samples could not be assigned to a response wave",
                meta.as_object(),
            );
        }
        let step_start = checkpoint
            .active_turn
            .as_ref()
            .map(|active| active.emitted_step_count)
            .unwrap_or(0)
            + 1;
        let closed = if terminal {
            extraction.turn.steps.len()
        } else {
            extraction.committed_step_count
        };
        let mut committed = extraction.turn.clone();
        if closed != extraction.turn.steps.len() {
            committed.steps.truncate(closed);
        }
        let input_context = self
            .resolve_input_context(rt, file_path, checkpoint, meta.as_ref())
            .await?;
        let mut built = build_codex_transcript_segment(
            &committed,
            &CodexTranscriptBuildOptions {
                include_prompt: checkpoint
                    .active_turn
                    .as_ref()
                    .is_none_or(|active| !active.emitted_prompt),
                start_step_number: step_start,
                input_context,
                context_step_count: Some(committed.steps.len()),
            },
        );
        if let (Some(meta), Some(active)) = (meta.as_ref(), checkpoint.active_turn.as_mut()) {
            let canonical = sources.iter().any(|source| {
                source.record["type"] == "response_item"
                    && source.record["payload"]["type"] == "message"
                    && is_codex_work_input(source, &extraction.turn.transcript_turn_id)
            });
            let new_work = sources.iter().any(|source| {
                source.start_offset >= checkpoint.scan_offset
                    && (!canonical || source.record["type"] != "event_msg")
                    && is_codex_work_input(source, &extraction.turn.transcript_turn_id)
            });
            if !active.delegation_unbound || new_work {
                let resolved = self.body.with_shared(|shared| {
                    shared.linker.resolve_work(
                        meta,
                        &extraction.turn,
                        &sources,
                        checkpoint.first_owned_turn_id.as_deref()
                            == Some(&extraction.turn.transcript_turn_id),
                    )
                });
                if let Some(link) = resolved {
                    active.delegation = Some(link);
                    active.delegation_unbound = false;
                } else if new_work && active.delegation.is_some() {
                    active.delegation = None;
                    active.delegation_unbound = true;
                }
            }
        }
        let delegation = checkpoint
            .active_turn
            .as_ref()
            .and_then(|active| active.delegation.clone());
        if let Some(link) = delegation.as_ref().filter(|_| terminal) {
            self.body.with_shared(|shared| {
                shared
                    .linker
                    .register_completed_work_result(link, &extraction.turn, &sources)
            });
        }
        let trace_id = checkpoint
            .active_turn
            .as_ref()
            .and_then(|active| active.emitted_trace_id.clone())
            .or_else(|| {
                delegation
                    .as_ref()
                    .and_then(|link| link.parent_trace_id.clone())
            })
            .or_else(|| built.entries.first_trace_id())
            .unwrap_or_else(|| super::super::invocation_audit::turn_trace_id(&extraction.turn));
        for entry in &mut built.entries {
            entry.trace_id = Some(trace_id.clone());
        }
        if let Some(link) = &delegation {
            super::super::invocation_audit::stamp_delegation(
                &mut built.entries,
                link,
                meta.as_ref(),
                link.parent_trace_id.as_deref() == Some(trace_id.as_str()),
            );
        }
        let dispatch_turn =
            super::super::invocation_audit::with_pending_dispatches(&extraction.turn, &sources);
        let spawns = extract_codex_spawn_descriptors(&dispatch_turn, &sources, &trace_id);
        self.body
            .with_shared(|shared| shared.linker.register_spawns(&spawns));
        let mut known = if spawns.is_empty() {
            Vec::new()
        } else {
            self.body.with_shared(|shared| {
                shared
                    .linker
                    .get_delegations_for_parent(&extraction.turn.session_id)
            })
        };
        let dispatches: Vec<_> = spawns
            .iter()
            .map(|spawn| {
                known
                    .iter()
                    .find(|known| known.invocation_id == spawn.invocation_id)
                    .cloned()
                    .unwrap_or_else(|| spawn.clone())
            })
            .collect();
        built.entries =
            super::super::invocation_audit::append_invocations(built.entries, &dispatches);
        if closed < dispatch_turn.steps.len() && !dispatches.is_empty() {
            let all = build_codex_transcript_segment(
                &dispatch_turn,
                &CodexTranscriptBuildOptions {
                    include_prompt: false,
                    start_step_number: step_start,
                    ..Default::default()
                },
            );
            let mut pending =
                super::super::invocation_audit::append_invocations(all.entries, &dispatches);
            pending.retain(|entry| entry.event_name == Some(AgentEventName::AgentInvoke));
            for entry in &mut pending {
                entry.trace_id = Some(trace_id.clone());
            }
            if let Some(link) = &delegation {
                super::super::invocation_audit::stamp_delegation(
                    &mut pending,
                    link,
                    meta.as_ref(),
                    link.parent_trace_id.as_deref() == Some(trace_id.as_str()),
                );
            }
            built.entries.extend(pending);
        }
        let mut audit_base =
            super::super::invocation_audit::audit_context(&extraction.turn, &trace_id);
        if let Some(link) = &delegation {
            super::super::invocation_audit::stamp_delegation(
                std::slice::from_mut(&mut audit_base),
                link,
                meta.as_ref(),
                link.parent_trace_id.as_deref() == Some(trace_id.as_str()),
            );
        }
        if has_codex_result_delivery(&built.entries, &sources, &dispatches) {
            if spawns.is_empty() {
                known = self.body.with_shared(|shared| {
                    shared
                        .linker
                        .get_delegations_for_parent(&extraction.turn.session_id)
                });
            }
            built.entries = self.body.with_shared(|shared| {
                super::super::invocation_audit::append_agent_results(
                    built.entries,
                    &sources,
                    &known,
                    super::super::invocation_audit::ResultContext {
                        receiving_session: &extraction.turn.session_id,
                        delivered: &mut shared.delivered_invocations,
                        fallback: &audit_base,
                        pending: &mut shared.pending_agent_results,
                        file_path,
                        inode: checkpoint.inode,
                    },
                )
            });
        }
        if let Some(active) = checkpoint.active_turn.as_mut() {
            if !built.entries.is_empty() {
                active.emitted_trace_id = Some(trace_id);
            }
        }
        let mut ready = built.entries.clone();
        if terminal
            && (!ready.is_empty()
                || checkpoint
                    .active_turn
                    .as_ref()
                    .is_some_and(|active| active.emitted_trace_id.is_some()))
        {
            let marker_base = ready.last().unwrap_or(&audit_base);
            if let Some(mut marker) =
                codex_turn_end_marker(std::slice::from_ref(marker_base), &extraction.turn)
            {
                for key in [
                    "agent.codex.delegated",
                    "agent.codex.parent_span_id",
                    "gen_ai.agent.scope",
                    "gen_ai.agent.depth",
                    "gen_ai.agent.parent.id",
                    "gen_ai.agent.parent.invocation.id",
                    "gen_ai.subagent.parent_tool_call.id",
                ] {
                    if let Some(value) = marker_base.extra.get(key) {
                        marker.extra.insert(key.into(), value.clone());
                    }
                }
                ready.push(marker);
            }
        }
        let filtered = if let Some(active) = checkpoint.active_turn.as_mut() {
            filter_new_segment_entries(ready.clone(), active)
        } else {
            SegmentFilterResult {
                input_entry_count: ready.len(),
                entries: ready.clone(),
                deduplicated_entry_count: 0,
                rejected_entry_count: 0,
            }
        };
        let all_already_emitted = filtered.all_already_emitted();
        let SegmentFilterResult {
            entries,
            deduplicated_entry_count,
            rejected_entry_count,
            ..
        } = filtered;
        if terminal && entries.is_empty() {
            let diagnostics = json!({
                "sourceRecordCount": records.items.len(),
                "stepCount": extraction.turn.steps.len(),
                "toolCount": extraction.turn.steps.iter().map(|step| step.tools.len()).sum::<usize>(),
                "tokenUsageCount": extraction.turn.steps.iter().filter(|step| step.token_usage.is_some()).count(),
                "unmatchedTokenUsageCount": extraction.turn.unmatched_token_usages.len(),
                "builtEntryCount": built.entries.len(),
                "readyEntryCount": ready.len(),
                "deduplicatedEntryCount": deduplicated_entry_count,
                "rejectedEntryCount": rejected_entry_count,
                "emittedEntryCount": entries.len(),
                "previouslyEmittedStepCount": active.emitted_step_count,
            });
            let meta = json!({
                "transcriptPath": file_path,
                "turnId": active.turn_id,
                "terminalStatus": extraction.turn.status.as_str(),
                "diagnostics": diagnostics,
            });
            if built.entries.is_empty() {
                rt.debug(
                    "processed terminal Codex turn without observable entries",
                    meta.as_object(),
                );
            } else if all_already_emitted {
                rt.debug(
                    "terminal Codex turn entries were already emitted incrementally",
                    meta.as_object(),
                );
            } else {
                rt.warn(
                    "processed terminal Codex turn produced no explainable new entries",
                    meta.as_object(),
                );
            }
        }
        if let Some(active) = checkpoint.active_turn.as_mut() {
            active.emitted_step_count += closed as u64;
            if closed > 0 {
                let range = extraction.committed_step_ranges.get(closed - 1);
                active.input_context =
                    Some(persisted_input_context(&built.next_input_context, range));
                if let Some(next) = extraction.next_step_started_at_ms {
                    active.next_step_started_at_ms = Some(next);
                }
                if let Some(total) = extraction.last_cumulative_token_total {
                    active.last_cumulative_token_total = Some(total);
                }
            }
        }
        let consumed = if terminal {
            end_offset
        } else {
            extraction.consumed_end_offset
        };
        let resource = self
            .read_wakeup_resource_attributes(rt, &extraction.turn.session_id)
            .await;
        let span = self
            .read_turn_span_attributes(rt, &extraction.turn.session_id, &active.turn_id)
            .await;
        let mut output = if let Some(resource) = resource {
            attach_wakeup_resource_attributes(entries, &resource)
        } else {
            entries
        };
        if let Some(span) = span {
            attach_turn_span_attributes(&mut output, &span);
        }
        // Independent child session identities must retain the parent's
        // workspace exclusion even after the parent turn has completed.
        if let Some(parent) = delegation
            .as_ref()
            .map(|link| link.parent_thread_id.as_str())
            .or_else(|| {
                meta.as_ref()
                    .and_then(|meta| meta.parent_thread_id.as_deref())
            })
        {
            let parent_record = json!({ "gen_ai.session.id": parent });
            if !rt.with_workspace_policy(|policy| {
                policy.allows(parent_record.as_object().expect("parent record"), "codex")
            }) {
                output.clear();
            }
        }
        let kind = if output.is_empty() {
            RecoveryKind::ProcessedEmpty
        } else {
            RecoveryKind::ProcessedEmitted
        };
        Ok(Recovery {
            kind,
            entries: output,
            consumed_end_offset: consumed,
            diagnostics: Diagnostics {
                source_record_count: records.items.len(),
            },
        })
    }
}

trait FirstTrace {
    fn first_trace_id(&self) -> Option<String>;
}

impl FirstTrace for Vec<AgentActivityEntry> {
    fn first_trace_id(&self) -> Option<String> {
        self.first().and_then(|entry| entry.trace_id.clone())
    }
}

fn empty_unparseable(end_offset: i64) -> Recovery {
    Recovery {
        kind: RecoveryKind::Unparseable,
        entries: Vec::new(),
        consumed_end_offset: end_offset,
        diagnostics: Diagnostics {
            source_record_count: 0,
        },
    }
}

struct SegmentFilterResult {
    input_entry_count: usize,
    entries: Vec<AgentActivityEntry>,
    deduplicated_entry_count: usize,
    rejected_entry_count: usize,
}

impl SegmentFilterResult {
    fn all_already_emitted(&self) -> bool {
        self.input_entry_count > 0
            && self.entries.is_empty()
            && self.rejected_entry_count == 0
            && self.deduplicated_entry_count == self.input_entry_count
    }
}

fn filter_new_segment_entries(
    entries: Vec<AgentActivityEntry>,
    active: &mut CodexActiveTranscriptTurn,
) -> SegmentFilterResult {
    let input_entry_count = entries.len();
    let mut requests: HashSet<String> = active.emitted_step_request_ids.iter().cloned().collect();
    let mut responses: HashSet<String> = active.emitted_step_response_ids.iter().cloned().collect();
    let mut calls: HashSet<String> = active.emitted_tool_call_ids.iter().cloned().collect();
    let mut results: HashSet<String> = active.emitted_tool_result_ids.iter().cloned().collect();
    let mut out = Vec::new();
    let mut deduplicated_entry_count = 0;
    let mut rejected_entry_count = 0;
    let mut audits: HashSet<String> = active.emitted_audit_event_ids.iter().cloned().collect();
    for mut entry in entries {
        if matches!(
            entry.event_name,
            Some(
                AgentEventName::ModelRequest
                    | AgentEventName::ModelResponse
                    | AgentEventName::GenAiToolCall
                    | AgentEventName::GenAiToolResult
                    | AgentEventName::AgentInvoke
                    | AgentEventName::AgentResult
            )
        ) {
            if audits.insert(entry.event_id.clone()) {
                out.push(entry);
            } else if entry.event_id.is_empty() {
                rejected_entry_count += 1;
            } else {
                deduplicated_entry_count += 1;
            }
            continue;
        }
        if entry.event_name == Some(AgentEventName::Other) {
            if entry.turn_end == Some(true) {
                out.push(entry);
                continue;
            }
            if active.emitted_prompt {
                deduplicated_entry_count += 1;
                continue;
            }
            active.emitted_prompt = true;
            entry.turn_start = Some(true);
            out.push(entry);
            continue;
        }
        let step_id = entry.step_id.clone().unwrap_or_default();
        let tool_id = entry.tool_call_id.clone().unwrap_or_default();
        if entry.event_name == Some(AgentEventName::LlmRequest) {
            if step_id.is_empty() {
                rejected_entry_count += 1;
                continue;
            }
            if !requests.insert(step_id) {
                deduplicated_entry_count += 1;
                continue;
            }
            out.push(entry);
        } else if entry.event_name == Some(AgentEventName::LlmResponse) {
            if step_id.is_empty() {
                rejected_entry_count += 1;
                continue;
            }
            if !responses.insert(step_id) {
                deduplicated_entry_count += 1;
                continue;
            }
            out.push(entry);
        } else if entry.event_name == Some(AgentEventName::ToolCall) {
            if tool_id.is_empty() {
                rejected_entry_count += 1;
                continue;
            }
            if !calls.insert(tool_id) {
                deduplicated_entry_count += 1;
                continue;
            }
            out.push(entry);
        } else if entry.event_name == Some(AgentEventName::ToolResult) {
            if tool_id.is_empty() {
                rejected_entry_count += 1;
                continue;
            }
            if !results.insert(tool_id) {
                deduplicated_entry_count += 1;
                continue;
            }
            out.push(entry);
        } else {
            out.push(entry);
        }
    }
    active.emitted_step_request_ids = requests.into_iter().collect();
    active.emitted_step_response_ids = responses.into_iter().collect();
    active.emitted_tool_call_ids = calls.into_iter().collect();
    active.emitted_tool_result_ids = results.into_iter().collect();
    active.emitted_audit_event_ids = audits.into_iter().collect();
    SegmentFilterResult {
        input_entry_count,
        entries: out,
        deduplicated_entry_count,
        rejected_entry_count,
    }
}

fn persisted_input_context(
    context: &CodexTranscriptInputContext,
    range: Option<&super::super::types::CodexTranscriptSourceRange>,
) -> CodexTranscriptInputContext {
    let delta = context.delta.clone().unwrap_or_default();
    let bytes = json_bytes(&Value::Array(delta.clone()));
    if bytes <= MAX_PERSISTED_INPUT_CONTEXT_BYTES || range.is_none() {
        CodexTranscriptInputContext {
            hash: context.hash.clone(),
            delta: Some(delta),
            full_messages: context.full_messages.clone(),
            delta_range: None,
        }
    } else {
        CodexTranscriptInputContext {
            hash: context.hash.clone(),
            delta: None,
            full_messages: context.full_messages.clone(),
            delta_range: range.cloned(),
        }
    }
}

fn has_codex_result_delivery(
    entries: &[AgentActivityEntry],
    records: &[CodexTranscriptSourceRecord],
    spawns: &[CodexSpawnDescriptor],
) -> bool {
    if spawns.iter().any(|work| work.dispatch_failed) {
        return true;
    }
    if entries.iter().any(|entry| {
        entry.event_name == Some(AgentEventName::ToolResult)
            && entry.tool_name.as_deref().is_some_and(|name| {
                matches!(
                    name.rsplit(['.', '/']).next().unwrap_or(""),
                    "wait"
                        | "wait_agent"
                        | "wait_threads"
                        | "spawn_agent"
                        | "followup_task"
                        | "send_input"
                )
            })
    }) {
        return true;
    }
    static FINAL_ANSWER: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"Message Type:\s*FINAL_ANSWER").expect("result type"));
    records.iter().any(|source| {
        let record = &source.record;
        let Some(payload) = record.get("payload").and_then(Value::as_object) else {
            return false;
        };
        if record.get("type").and_then(Value::as_str) == Some("event_msg")
            && payload.get("type").and_then(Value::as_str) == Some("sub_agent_activity")
        {
            return matches!(
                payload.get("kind").and_then(Value::as_str),
                Some("completed" | "result" | "failed")
            );
        }
        record.get("type").and_then(Value::as_str) == Some("response_item")
            && payload.get("type").and_then(Value::as_str) == Some("agent_message")
            && payload
                .get("content")
                .and_then(Value::as_array)
                .is_some_and(|parts| {
                    parts.iter().any(|part| {
                        part.get("text")
                            .and_then(Value::as_str)
                            .is_some_and(|text| FINAL_ANSWER.is_match(text))
                    })
                })
    })
}

fn codex_turn_end_marker(
    entries: &[AgentActivityEntry],
    turn: &super::super::types::CodexExtractedTranscriptTurn,
) -> Option<AgentActivityEntry> {
    let source = entries
        .iter()
        .rev()
        .find(|entry| entry.event_name == Some(AgentEventName::LlmResponse))
        .or_else(|| entries.last())?;
    let terminal_time = ((turn.terminal_at_ms as i128) * 1_000_000).to_string();
    let event_id = hex::encode(Sha256::digest(
        format!("{}\0{}\0turn-end", turn.session_id, turn.transcript_turn_id).as_bytes(),
    ))[..32]
        .to_owned();
    let span_id = hex::encode(Sha256::digest(
        format!("{}\0{}\0agent", turn.session_id, turn.transcript_turn_id).as_bytes(),
    ))[..16]
        .to_owned();
    let mut fields = Map::new();
    fields.insert(
        "time_unix_nano".into(),
        Value::String(terminal_time.clone()),
    );
    if let Some(observed) = &source.observed_time_unix_nano {
        fields.insert(
            "observed_time_unix_nano".into(),
            Value::String(observed.clone()),
        );
    }
    fields.insert("event.id".into(), Value::String(event_id));
    fields.insert("event.name".into(), Value::String("other".into()));
    fields.insert("user.id".into(), Value::String(source.user_id.clone()));
    if let Some(trace) = &source.trace_id {
        fields.insert("trace_id".into(), Value::String(trace.clone()));
    }
    fields.insert("span_id".into(), Value::String(span_id));
    fields.insert(
        "parent_span_id".into(),
        Value::String(
            source
                .extra
                .get("agent.codex.parent_span_id")
                .and_then(Value::as_str)
                .unwrap_or("0000000000000001")
                .to_owned(),
        ),
    );
    fields.insert(
        "gen_ai.session.id".into(),
        Value::String(source.session_id.clone()),
    );
    if let Some(turn) = &source.turn_id {
        fields.insert("gen_ai.turn.id".into(), Value::String(turn.clone()));
    }
    fields.insert("gen_ai.turn.end".into(), Value::Bool(true));
    fields.insert(
        "gen_ai.agent.type".into(),
        Value::String(source.agent_type.clone()),
    );
    if let Some(agent) = &source.agent_id {
        fields.insert("gen_ai.agent.id".into(), Value::String(agent.clone()));
    }
    if let Some(name) = &source.agent_name {
        fields.insert("gen_ai.agent.name".into(), Value::String(name.clone()));
    }
    fields.insert(
        "gen_ai.provider.name".into(),
        Value::String(source.provider_name.clone()),
    );
    if let Some(value) = source.extra.get("agent.codex.transcript_turn_id") {
        fields.insert("agent.codex.transcript_turn_id".into(), value.clone());
    }
    if let Some(value) = source.extra.get("agent.codex.cwd") {
        fields.insert("agent.codex.cwd".into(), value.clone());
    }
    fields.insert(
        "agent.codex.turn_status".into(),
        Value::String(turn.status.as_str().to_owned()),
    );
    fields.insert("timestamp".into(), Value::String(terminal_time.clone()));
    Some(build_agent_activity_entry(&Value::Object(fields)))
}

fn attach_wakeup_resource_attributes(
    mut entries: Vec<AgentActivityEntry>,
    resource: &Map<String, Value>,
) -> Vec<AgentActivityEntry> {
    let worker = resource
        .get("agentteams.worker.name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned);
    for entry in &mut entries {
        entry.resource_attributes = Some(resource.clone());
        if let Some(worker) = &worker {
            entry.agent_name = Some(worker.clone());
        }
    }
    entries
}

fn attach_turn_span_attributes(entries: &mut [AgentActivityEntry], span: &HashMap<String, String>) {
    for entry in entries {
        for (key, value) in span {
            set_if_absent(entry, key, value);
        }
    }
}

fn set_if_absent(entry: &mut AgentActivityEntry, key: &str, value: &str) {
    let Ok(Value::Object(mut map)) = serde_json::to_value(&*entry) else {
        return;
    };
    if map.contains_key(key) {
        return;
    }
    map.insert(key.to_owned(), Value::String(value.to_owned()));
    if let Ok(updated) = serde_json::from_value(Value::Object(map)) {
        *entry = updated;
    }
}

fn blob_as_dyn<F>(func: &F) -> &dyn Fn(&BlobToUriParams) -> Option<UriResult>
where
    F: Fn(&BlobToUriParams) -> Option<UriResult>,
{
    func
}

impl<'a> CodexTranscriptEngine<'a> {
    fn make_blob<'b>(
        &'b self,
        rt: &'b InputRuntime,
        transcript_path: &str,
        cwd: Option<&str>,
        attachment_parent: Option<&str>,
    ) -> impl Fn(&BlobToUriParams) -> Option<UriResult> + 'b {
        let transcript_path = transcript_path.to_owned();
        let cwd = cwd.map(str::to_owned);
        let attachment_parent = attachment_parent.map(str::to_owned);
        move |params: &BlobToUriParams| {
            let meta = self
                .body
                .with_shared(|shared| shared.meta_by_path.get(&transcript_path).cloned());
            let session = meta
                .as_ref()
                .map(|meta| meta.thread_id.clone())
                .filter(|id| !id.is_empty())
                .unwrap_or_else(|| session_id_from_transcript_path(&transcript_path));
            let mut record = Map::new();
            record.insert("gen_ai.session.id".into(), Value::String(session));
            if let Some(cwd) = &cwd {
                record.insert("cwd".into(), Value::String(cwd.clone()));
            }
            let allowed = rt.with_workspace_policy(|policy| policy.allows(&record, "codex"));
            if !allowed {
                return None;
            }
            if let Some(parent) = &attachment_parent {
                let mut parent_record = Map::new();
                parent_record.insert("gen_ai.session.id".into(), Value::String(parent.clone()));
                if !rt.with_workspace_policy(|policy| policy.allows(&parent_record, "codex")) {
                    return None;
                }
            }
            let processor = self.body.processor.as_ref()?;
            let cache_key = params
                .reuse_key
                .as_ref()
                .map(|key| format!("{transcript_path}\0{key}"));
            if let Some(cache_key) = &cache_key {
                if let Ok(mut cache) = self.body.uri_cache.lock() {
                    if let Some(hit) = cache.get_copied(cache_key) {
                        return Some(hit);
                    }
                }
            }
            let result = processor.blob_to_uri(params.clone());
            if let (Some(result), Some(cache_key)) = (result.clone(), cache_key) {
                if let Ok(mut cache) = self.body.uri_cache.lock() {
                    cache.set(cache_key, result.clone());
                }
            }
            result
        }
    }

    pub fn has_pending_fusion_for_parent(&self, rt: &InputRuntime, parent_thread_id: &str) -> bool {
        for key in rt.state_store.keys() {
            if !key.starts_with("codex-transcript:") {
                continue;
            }
            if self
                .read_checkpoint(rt, &key)
                .and_then(|checkpoint| checkpoint.pending_fusion)
                .is_some_and(|fusion| fusion.parent_thread_id == parent_thread_id)
            {
                return true;
            }
        }
        false
    }

    async fn baseline_boundary(
        &self,
        rt: &InputRuntime,
        file_path: &str,
        copied: bool,
        restored: Option<super::source_ownership::BaselineFloor>,
    ) -> anyhow::Result<(u64, i64)> {
        use super::source_ownership::{self, BaselineFloor};
        let floor = if let Some(floor) = restored {
            anyhow::ensure!(floor.copied == copied, "baseline source kind changed");
            floor
        } else {
            let witness = source_ownership::capture_baseline(file_path).await?;
            let size = i64::try_from(witness.size())?;
            // A verified full owner probe has already observed this exact LF
            // boundary. Reuse its bounded metadata proof, preserving the first
            // durable ownership floor before any checkpoint reconstruction.
            let version = scan::file_version_snapshot(file_path).await?;
            let known_complete = if !copied && version.size == size {
                let key = owner_probe_key(file_path, &version, size);
                self.body.with_shared(|shared| {
                    shared.owner_offset_probes.complete_boundary(&key, &version)
                })
            } else {
                None
            };
            let offset = match known_complete {
                Some(end) if end == size => end,
                _ => last_complete_jsonl_offset(file_path, size, Some(rt)).await?,
            };
            let floor = BaselineFloor {
                offset: u64::try_from(offset)?,
                copied,
            };
            // This is the first-install exclusion boundary, not delivered progress.
            // Persist before constructing an in-memory baseline checkpoint.
            source_ownership::remember_baseline(&self.body.wakeup_dir, file_path, witness, floor)
                .await?;
            floor
        };
        self.validate_baseline_boundary(file_path, floor).await?;
        let (inode, size, _) = file_meta_snapshot(file_path).await?;
        let offset = i64::try_from(floor.offset)?;
        anyhow::ensure!(
            offset <= size,
            "rollout shrank below initial baseline floor"
        );
        Ok((inode, offset))
    }

    async fn validate_baseline_boundary(
        &self,
        file_path: &str,
        floor: super::source_ownership::BaselineFloor,
    ) -> anyhow::Result<()> {
        let current =
            super::source_ownership::baseline_floor(&self.body.wakeup_dir, file_path).await?;
        anyhow::ensure!(
            current == Some(floor),
            "rollout identity or initial floor changed"
        );
        Ok(())
    }

    pub async fn baseline_file(
        &self,
        rt: &InputRuntime,
        file_path: &str,
        key: &str,
    ) -> anyhow::Result<()> {
        self.baseline_file_at(rt, file_path, key, None).await
    }

    pub async fn restore_baseline_file(
        &self,
        rt: &InputRuntime,
        file_path: &str,
        key: &str,
        floor: super::source_ownership::BaselineFloor,
    ) -> anyhow::Result<()> {
        self.baseline_file_at(rt, file_path, key, Some(floor)).await
    }

    async fn baseline_file_at(
        &self,
        rt: &InputRuntime,
        file_path: &str,
        key: &str,
        restored: Option<super::source_ownership::BaselineFloor>,
    ) -> anyhow::Result<()> {
        let (inode, size) = self
            .baseline_boundary(rt, file_path, false, restored)
            .await?;
        let mut owner = None;
        let mut active: Option<CodexActiveTranscriptTurn> = None;
        let stats = scan_json_lines_through_quarantine(file_path, 0, size, Some(rt), |line| {
            let Some(payload) = line.record.get("payload").and_then(Value::as_object) else {
                return true;
            };
            if line.record.get("type").and_then(Value::as_str) == Some("session_meta") {
                owner = select_owner_session_meta_offset(file_path, owner, &line);
                return true;
            }
            if let Some(turn_id) = turn_id_for_start(&line.record, payload) {
                if active
                    .as_ref()
                    .is_none_or(|current| current.turn_id != turn_id)
                {
                    active = Some(create_active_turn(
                        turn_id.clone(),
                        line.start_offset,
                        utils::timestamp_ms(&line.record, now_ms()),
                        true,
                    ));
                }
                if let Some(current) = active.as_mut() {
                    if current.turn_id == turn_id {
                        update_active_turn_metadata(current, &line.record, payload);
                    }
                }
                return true;
            }
            if terminal_turn_id_for(&line.record, payload).as_deref()
                == active.as_ref().map(|item| item.turn_id.as_str())
            {
                active = None;
            }
            true
        })
        .await?;
        anyhow::ensure!(
            stats.next_offset == size,
            "baseline floor is not a complete JSONL boundary"
        );
        self.validate_baseline_boundary(
            file_path,
            super::source_ownership::BaselineFloor {
                offset: u64::try_from(size)?,
                copied: false,
            },
        )
        .await?;
        if let Some(active) = active.as_mut() {
            active.start_offset = stats.next_offset;
        }
        self.save_checkpoint(
            rt,
            key,
            &CodexTranscriptCheckpoint {
                first_owned_turn_id: None,
                inode,
                scan_offset: stats.next_offset,
                active_turn: active,
                pending_terminal: None,
                deferred_terminals: Vec::new(),
                pending_fusion: None,
                pending_subagent: None,
                owner_session_meta_offset: owner,
                fork_bootstrap: None,
            },
        );
        Ok(())
    }

    pub async fn park_fork_baseline(
        &self,
        rt: &InputRuntime,
        file_path: &str,
        key: &str,
    ) -> anyhow::Result<()> {
        self.park_fork_baseline_at(rt, file_path, key, None).await
    }

    pub async fn restore_fork_baseline(
        &self,
        rt: &InputRuntime,
        file_path: &str,
        key: &str,
        floor: super::source_ownership::BaselineFloor,
    ) -> anyhow::Result<()> {
        self.park_fork_baseline_at(rt, file_path, key, Some(floor))
            .await
    }

    async fn park_fork_baseline_at(
        &self,
        rt: &InputRuntime,
        file_path: &str,
        key: &str,
        restored: Option<super::source_ownership::BaselineFloor>,
    ) -> anyhow::Result<()> {
        let (inode, scan_offset) = self
            .baseline_boundary(rt, file_path, true, restored)
            .await?;
        let version = scan::file_version_snapshot(file_path).await?;
        let owner = self
            .find_owner_offset(rt, file_path, &version, Some(scan_offset))
            .await?;
        self.validate_baseline_boundary(
            file_path,
            super::source_ownership::BaselineFloor {
                offset: u64::try_from(scan_offset)?,
                copied: true,
            },
        )
        .await?;
        self.save_checkpoint(
            rt,
            key,
            &CodexTranscriptCheckpoint {
                first_owned_turn_id: None,
                inode,
                scan_offset,
                active_turn: None,
                pending_terminal: None,
                deferred_terminals: Vec::new(),
                pending_fusion: None,
                pending_subagent: None,
                owner_session_meta_offset: owner,
                fork_bootstrap: Some(CodexForkBootstrap {
                    state: ForkBootstrapState::BaselineSearch,
                    search_offset: 0,
                    initial_turn_id: None,
                    recovery_turn_id: None,
                    tail_candidate: None,
                }),
            },
        );
        Ok(())
    }
}

struct Prepared {
    ready: bool,
    changed: bool,
}

impl<'a> CodexTranscriptEngine<'a> {
    async fn prepare_copied_transcript(
        &self,
        rt: &InputRuntime,
        file_path: &str,
        file_size: i64,
        owner_meta: &CodexTranscriptMeta,
        checkpoint: &mut CodexTranscriptCheckpoint,
    ) -> anyhow::Result<Prepared> {
        let previous_bootstrap = checkpoint.fork_bootstrap.clone();
        if checkpoint.scan_offset == 0 && checkpoint.fork_bootstrap.is_none() {
            checkpoint.fork_bootstrap = Some(CodexForkBootstrap {
                state: ForkBootstrapState::LivePending,
                search_offset: 0,
                initial_turn_id: None,
                recovery_turn_id: None,
                tail_candidate: None,
            });
        }
        let Some(current) = checkpoint.fork_bootstrap.clone() else {
            return Ok(Prepared {
                ready: true,
                changed: false,
            });
        };
        if current.state == ForkBootstrapState::BaselineTail {
            let rebuilt = self
                .rebuild_fork_baseline_tail(rt, file_path, checkpoint)
                .await?;
            return Ok(Prepared {
                ready: rebuilt,
                changed: rebuilt || previous_bootstrap != checkpoint.fork_bootstrap,
            });
        }
        let marker = self
            .read_wakeup_marker(rt, &owner_meta.thread_id, file_path)
            .await;
        let mut bootstrap = current;
        if marker
            .as_ref()
            .and_then(|marker| marker.initial_turn_id.as_ref())
            .is_some_and(|id| bootstrap.initial_turn_id.as_deref() != Some(id.as_str()))
        {
            bootstrap.initial_turn_id = marker
                .as_ref()
                .and_then(|marker| marker.initial_turn_id.clone());
            bootstrap.recovery_turn_id = marker
                .as_ref()
                .and_then(|marker| marker.recovery_turn_id.clone());
            bootstrap.search_offset = 0;
        } else if marker
            .as_ref()
            .and_then(|marker| marker.recovery_turn_id.as_ref())
            .is_some_and(|id| bootstrap.recovery_turn_id.as_deref() != Some(id.as_str()))
        {
            bootstrap.recovery_turn_id = marker
                .as_ref()
                .and_then(|marker| marker.recovery_turn_id.clone());
            if bootstrap.initial_turn_id.is_none() {
                bootstrap.search_offset = 0;
            }
        }
        let safe = scan::bounded_search_offset(bootstrap.search_offset, file_size);
        if safe != bootstrap.search_offset {
            let diagnostics = json!({
                "transcriptPath": file_path,
                "searchOffset": bootstrap.search_offset,
                "repairedSearchOffset": safe,
            });
            rt.warn(
                "repaired invalid Codex fork bootstrap search offset",
                diagnostics.as_object(),
            );
            bootstrap.search_offset = safe;
        }
        checkpoint.fork_bootstrap = Some(bootstrap.clone());
        let searched_new = bootstrap.search_offset < file_size;
        let search_stat = scan::file_version_snapshot(file_path).await?;
        if search_stat.size != file_size
            || !self
                .incomplete_tail_ready(rt, file_path, bootstrap.search_offset)
                .await?
        {
            return Ok(Prepared {
                ready: false,
                changed: previous_bootstrap != checkpoint.fork_bootstrap,
            });
        }
        let located = find_turn_start_offset(
            file_path,
            &owner_meta.thread_id,
            bootstrap.initial_turn_id.as_deref(),
            bootstrap.recovery_turn_id.as_deref(),
            bootstrap.search_offset,
            file_size,
            Some(rt),
        )
        .await?;
        if let Some(tail) = located
            .incomplete_tail
            .filter(|tail| tail.end_offset == file_size)
        {
            if scan::file_version_snapshot(file_path).await? == search_stat {
                self.remember_incomplete_tail(file_path, tail);
            }
        }
        let Some(start) = located.start_offset else {
            checkpoint.fork_bootstrap = Some(CodexForkBootstrap {
                state: bootstrap.state,
                initial_turn_id: bootstrap.initial_turn_id.clone(),
                recovery_turn_id: bootstrap.recovery_turn_id.clone(),
                search_offset: located.next_offset,
                tail_candidate: None,
            });
            if located.next_offset >= file_size
                && searched_new
                && bootstrap.initial_turn_id.is_none()
                && uuid_v7_timestamp_ms(&owner_meta.thread_id).is_none()
                && bootstrap.recovery_turn_id.is_none()
            {
                let meta = json!({
                    "transcriptPath": file_path,
                    "threadId": owner_meta.thread_id,
                    "searchedBytes": located.next_offset,
                });
                rt.warn(
                    "Codex fork bootstrap has no usable Hook or UUIDv7 ownership evidence",
                    meta.as_object(),
                );
            }
            return Ok(Prepared {
                ready: false,
                changed: previous_bootstrap != checkpoint.fork_bootstrap,
            });
        };
        let previous = checkpoint.scan_offset;
        if bootstrap.state == ForkBootstrapState::BaselineSearch && start < previous {
            checkpoint.fork_bootstrap = Some(CodexForkBootstrap {
                state: ForkBootstrapState::BaselineTail,
                initial_turn_id: bootstrap.initial_turn_id.clone(),
                recovery_turn_id: bootstrap.recovery_turn_id.clone(),
                search_offset: start,
                tail_candidate: None,
            });
            let rebuilt = self
                .rebuild_fork_baseline_tail(rt, file_path, checkpoint)
                .await?;
            return Ok(Prepared {
                ready: rebuilt,
                changed: rebuilt || previous_bootstrap != checkpoint.fork_bootstrap,
            });
        }
        checkpoint.scan_offset = previous.max(start);
        checkpoint.fork_bootstrap = if previous < start {
            Some(CodexForkBootstrap {
                state: ForkBootstrapState::LivePending,
                initial_turn_id: bootstrap.initial_turn_id.clone(),
                recovery_turn_id: bootstrap.recovery_turn_id.clone(),
                search_offset: start,
                tail_candidate: None,
            })
        } else {
            None
        };
        let start_hook_only = previous < start
            && marker
                .as_ref()
                .and_then(|marker| marker.hook_event.as_deref())
                .is_some_and(|event| event == "user-prompt-submit" || event == "subagent-start");
        Ok(Prepared {
            ready: !start_hook_only,
            changed: true,
        })
    }

    async fn rebuild_fork_baseline_tail(
        &self,
        rt: &InputRuntime,
        file_path: &str,
        checkpoint: &mut CodexTranscriptCheckpoint,
    ) -> anyhow::Result<bool> {
        let Some(bootstrap) = checkpoint.fork_bootstrap.clone() else {
            return Ok(true);
        };
        if bootstrap.state != ForkBootstrapState::BaselineTail {
            return Ok(true);
        }
        let baseline_end = checkpoint.scan_offset;
        let search_offset = scan::bounded_search_offset(bootstrap.search_offset, baseline_end);
        let scan_end = baseline_end.min(search_offset + MAX_SCAN_BYTES_PER_FILE_CYCLE);
        let mut candidate = bootstrap.tail_candidate.clone();
        let mut scan = scan_json_lines(file_path, search_offset, scan_end, Some(rt), |line| {
            apply_tail_line(&mut candidate, &line);
            true
        })
        .await?;
        if scan.next_offset == search_offset && scan_end < baseline_end {
            scan = scan_json_lines(file_path, search_offset, baseline_end, Some(rt), |line| {
                apply_tail_line(&mut candidate, &line);
                false
            })
            .await?;
        }
        if scan.next_offset < baseline_end {
            checkpoint.fork_bootstrap = Some(CodexForkBootstrap {
                search_offset: scan.next_offset,
                tail_candidate: candidate,
                ..bootstrap
            });
            return Ok(false);
        }
        if let Some(mut candidate) = candidate {
            candidate.start_offset = baseline_end;
            checkpoint.active_turn = Some(candidate);
        }
        checkpoint.fork_bootstrap = None;
        Ok(true)
    }

    async fn resolve_input_context(
        &self,
        rt: &InputRuntime,
        file_path: &str,
        checkpoint: &CodexTranscriptCheckpoint,
        meta: Option<&CodexTranscriptMeta>,
    ) -> anyhow::Result<Option<CodexTranscriptInputContext>> {
        let Some(active) = checkpoint.active_turn.as_ref() else {
            return Ok(None);
        };
        let Some(context) = active.input_context.clone() else {
            return Ok(None);
        };
        if context.delta.is_some() {
            return Ok(Some(context));
        }
        let Some(range) = context.delta_range.clone() else {
            return Ok(Some(context));
        };
        let records =
            read_json_lines(file_path, range.start_offset, range.end_offset, Some(rt)).await?;
        let maps: Vec<Map<String, Value>> =
            records.items.into_iter().map(|line| line.record).collect();
        let previous = extract_codex_partial_turn(
            &maps,
            meta,
            &session_id_from_transcript_path(file_path),
            &active.turn_id,
            &ExtractOptions {
                require_terminal: false,
                started_at_ms: Some(active.started_at_ms),
                next_step_started_at_ms: active.next_step_started_at_ms,
                last_cumulative_token_total: active.last_cumulative_token_total,
                model: active.model.clone(),
                cwd: active.cwd.clone(),
                developer_instructions: active.developer_instructions.clone(),
                blob_to_uri: None,
                upload_mode: None,
            },
        );
        let Some(last) = previous.as_ref().and_then(|turn| turn.steps.last()) else {
            let meta = json!({ "transcriptPath": file_path, "turnId": active.turn_id });
            rt.warn(
                "could not rebuild oversized Codex input delta from transcript range",
                meta.as_object(),
            );
            return Ok(Some(context));
        };
        Ok(Some(CodexTranscriptInputContext {
            delta: Some(next_input_messages_for_step(last)),
            ..context
        }))
    }
}

fn apply_tail_line(candidate: &mut Option<CodexActiveTranscriptTurn>, line: &JsonLine) {
    let Some(payload) = line.record.get("payload").and_then(Value::as_object) else {
        return;
    };
    if line.record.get("type").and_then(Value::as_str) == Some("session_meta") {
        return;
    }
    if let Some(turn_id) = turn_id_for_start(&line.record, payload) {
        if candidate
            .as_ref()
            .is_none_or(|current| current.turn_id != turn_id)
        {
            *candidate = Some(create_active_turn(
                turn_id.clone(),
                line.start_offset,
                utils::timestamp_ms(&line.record, now_ms()),
                true,
            ));
        }
        if let Some(current) = candidate.as_mut() {
            update_active_turn_metadata(current, &line.record, payload);
        }
        return;
    }
    if terminal_turn_id_for(&line.record, payload).as_deref()
        == candidate.as_ref().map(|item| item.turn_id.as_str())
    {
        *candidate = None;
    }
}

fn lexical_absolute_path(path: &str) -> Option<std::path::PathBuf> {
    use std::path::Component;
    let absolute = std::path::absolute(path).ok()?;
    let mut normalized = std::path::PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    Some(normalized)
}

struct WakeupMarker {
    initial_turn_id: Option<String>,
    recovery_turn_id: Option<String>,
    hook_event: Option<String>,
}

impl<'a> CodexTranscriptEngine<'a> {
    async fn read_wakeup_marker(
        &self,
        rt: &InputRuntime,
        session_id: &str,
        transcript_path: &str,
    ) -> Option<WakeupMarker> {
        let path = Path::new(&self.body.wakeup_dir)
            .join(format!("{}.json", safe_wakeup_session_part(session_id)));
        let raw = tokio::fs::read_to_string(&path).await.ok()?;
        let parsed: Value = serde_json::from_str(&raw).ok()?;
        let record = as_record(&parsed)?;
        if string_value(record.get("session_id")) != Some(session_id) {
            return None;
        }
        if let Some(recorded) = string_value(record.get("transcript_path")) {
            let canonical = tokio::try_join!(
                tokio::fs::canonicalize(recorded),
                tokio::fs::canonicalize(transcript_path)
            );
            let reason = match canonical {
                Ok((recorded_real, transcript_real)) if recorded_real != transcript_real => Some(
                    "Codex wakeup transcript path differs from discovered session file; accepting session anchor",
                ),
                Err(_)
                    if lexical_absolute_path(recorded)
                        != lexical_absolute_path(transcript_path) =>
                {
                    Some(
                        "Codex wakeup transcript path could not be canonicalized; accepting session anchor",
                    )
                }
                _ => None,
            };
            if let Some(reason) = reason {
                let meta = json!({
                    "sessionId": session_id,
                    "recordedTranscriptPath": recorded,
                    "transcriptPath": transcript_path,
                });
                rt.warn(reason, meta.as_object());
            }
        }
        Some(WakeupMarker {
            initial_turn_id: string_value(record.get("initial_turn_id")).map(str::to_owned),
            recovery_turn_id: string_value(record.get("recovery_turn_id")).map(str::to_owned),
            hook_event: string_value(record.get("hook_event")).map(str::to_owned),
        })
    }

    async fn read_wakeup_resource_attributes(
        &self,
        rt: &InputRuntime,
        session_id: &str,
    ) -> Option<Map<String, Value>> {
        let marker = Path::new(&self.body.wakeup_dir)
            .join(format!("{}.json", safe_wakeup_session_part(session_id)));
        let raw = tokio::fs::read_to_string(&marker).await.ok()?;
        let parsed = match serde_json::from_str::<Value>(&raw) {
            Ok(value) => value,
            Err(_) => {
                let meta = json!({ "marker": marker.to_string_lossy() });
                rt.debug(
                    "Codex wakeup marker could not be parsed; resource attributes skipped",
                    meta.as_object(),
                );
                return None;
            }
        };
        let record = as_record(&parsed)?;
        let Some(attributes) = record.get("resourceAttributes").and_then(as_record) else {
            let meta = json!({ "marker": marker.to_string_lossy() });
            rt.debug(
                "Codex wakeup marker has no resourceAttributes; attribution skipped",
                meta.as_object(),
            );
            return None;
        };
        let mut out = Map::new();
        for key in WAKEUP_RESOURCE_ATTRIBUTE_KEYS {
            let Some(value) = attributes.get(*key).and_then(Value::as_str) else {
                continue;
            };
            let trimmed = value.trim();
            if trimmed.len() > MAX_WAKEUP_RESOURCE_ATTRIBUTE_VALUE_LENGTH || trimmed.is_empty() {
                continue;
            }
            out.insert((*key).to_owned(), Value::String(trimmed.to_owned()));
        }
        if out.is_empty() {
            None
        } else {
            Some(out)
        }
    }

    async fn read_turn_span_attributes(
        &self,
        rt: &InputRuntime,
        session_id: &str,
        turn_id: &str,
    ) -> Option<HashMap<String, String>> {
        let marker = Path::new(&self.body.span_context_dir)
            .join(span_context_marker_name(session_id, turn_id));
        let raw = tokio::fs::read_to_string(&marker).await.ok()?;
        let parsed = serde_json::from_str::<Value>(&raw).ok()?;
        let record = as_record(&parsed)?;
        if string_value(record.get("session_id")) != Some(session_id)
            || string_value(record.get("turn_id")) != Some(turn_id)
        {
            let meta = json!({ "marker": marker.to_string_lossy(), "sessionId": session_id, "turnId": turn_id });
            rt.debug(
                "Codex span context identifiers do not match the transcript turn",
                meta.as_object(),
            );
            return None;
        }
        if let Some(received) =
            string_value(record.get("received_at")).and_then(utils::parse_timestamp_ms)
        {
            if (now_ms() as i64) - received as i64 > SPAN_CONTEXT_TTL_MS {
                return None;
            }
        }
        let attributes = record.get("spanAttributes").and_then(as_record)?;
        let mut out = HashMap::new();
        for (raw_key, raw_value) in attributes {
            let key = raw_key.trim();
            if key.is_empty()
                || is_reserved_key(key)
                || SENSITIVE_SPAN_ATTRIBUTE_NAME_RE.is_match(key)
                || !raw_value.is_string()
            {
                continue;
            }
            let value = raw_value.as_str().unwrap_or("").trim();
            if value.is_empty() || value.len() > MAX_SPAN_ATTRIBUTE_VALUE_LENGTH {
                continue;
            }
            out.insert(key.to_owned(), value.to_owned());
        }
        if out.is_empty() {
            None
        } else {
            Some(out)
        }
    }

    pub async fn cleanup_expired_span_contexts(&self, _rt: &InputRuntime, now: i64) {
        let due = self.body.with_shared(|shared| {
            if now - shared.last_span_cleanup_at < SPAN_CONTEXT_CLEANUP_INTERVAL_MS {
                false
            } else {
                shared.last_span_cleanup_at = now;
                true
            }
        });
        if !due {
            return;
        }
        let mut entries = match tokio::fs::read_dir(&self.body.span_context_dir).await {
            Ok(entries) => entries,
            Err(_) => return,
        };
        let mut names = Vec::new();
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(".json") {
                names.push(name);
            }
        }
        names.sort();
        names.truncate(MAX_SPAN_CONTEXTS_PER_CLEANUP);
        for name in names {
            let path = Path::new(&self.body.span_context_dir).join(&name);
            if marker_expired(&path, now, SPAN_CONTEXT_TTL_MS).await {
                let _ = tokio::fs::remove_file(path).await;
            }
        }
    }

    async fn discover_dynamic_session_dirs(&self, canonical_default: &str) -> Vec<String> {
        let mut entries = match tokio::fs::read_dir(&self.body.wakeup_dir).await {
            Ok(entries) => entries,
            Err(_) => return Vec::new(),
        };
        let mut names = Vec::new();
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(".json") {
                names.push(name);
            }
        }
        let now = now_ms() as i64;
        self.cleanup_wakeup_markers(&names, now).await;
        names.sort_by(|left, right| right.cmp(left));
        names.truncate(MAX_WAKEUP_MARKERS_FOR_DISCOVERY);
        let mut tiers: [IndexMap<String, ()>; 3] =
            [IndexMap::new(), IndexMap::new(), IndexMap::new()];
        for name in names {
            let roots = read_codex_wakeup_roots(
                &Path::new(&self.body.wakeup_dir)
                    .join(name)
                    .to_string_lossy(),
                now,
            )
            .await;
            for (tier, candidates) in roots.into_iter().enumerate() {
                for candidate in candidates {
                    tiers[tier].insert(candidate, ());
                }
            }
        }
        let mut session_dirs = IndexMap::new();
        for tier in tiers {
            for candidate in tier.into_keys() {
                let Ok(canonical) = tokio::fs::canonicalize(&candidate).await else {
                    continue;
                };
                let canonical = canonical.to_string_lossy().into_owned();
                if canonical == canonical_default {
                    continue;
                }
                if tokio::fs::metadata(&canonical)
                    .await
                    .ok()
                    .is_some_and(|meta| meta.is_dir())
                {
                    session_dirs.insert(canonical, ());
                }
            }
        }
        let dropped = session_dirs.len().saturating_sub(MAX_DYNAMIC_SESSION_DIRS);
        if dropped > 0 {
            let warn = self.body.with_shared(|shared| {
                if now - shared.last_dynamic_warn_at >= WAKEUP_MARKER_CLEANUP_INTERVAL_MS {
                    shared.last_dynamic_warn_at = now;
                    true
                } else {
                    false
                }
            });
            if warn {
                let host = self
                    .body
                    .host
                    .lock()
                    .unwrap_or_else(|err| err.into_inner())
                    .as_ref()
                    .and_then(std::sync::Weak::upgrade);
                if let Some(host) = host {
                    let meta = json!({"dropped":dropped,"cap":MAX_DYNAMIC_SESSION_DIRS});
                    host.runtime.warn(
                        "Codex dynamic session root limit reached within scanned markers",
                        meta.as_object(),
                    );
                }
            }
        }
        session_dirs
            .into_keys()
            .take(MAX_DYNAMIC_SESSION_DIRS)
            .collect()
    }

    async fn cleanup_wakeup_markers(&self, names: &[String], now: i64) {
        let due = self.body.with_shared(|shared| {
            if now - shared.last_wakeup_cleanup_at < WAKEUP_MARKER_CLEANUP_INTERVAL_MS {
                false
            } else {
                shared.last_wakeup_cleanup_at = now;
                true
            }
        });
        if !due {
            return;
        }
        let mut ordered = names.to_vec();
        ordered.sort();
        ordered.truncate(MAX_WAKEUP_MARKERS_PER_CLEANUP);
        for name in ordered {
            let path = Path::new(&self.body.wakeup_dir).join(name);
            if marker_expired(&path, now, WAKEUP_MARKER_DISCOVERY_TTL_MS).await {
                let _ = tokio::fs::remove_file(path).await;
            }
        }
    }
}

async fn marker_expired(path: &Path, now: i64, ttl: i64) -> bool {
    if let Ok(raw) = tokio::fs::read_to_string(path).await {
        if let Ok(parsed) = serde_json::from_str::<Value>(&raw) {
            if let Some(record) = as_record(&parsed) {
                if let Some(received) =
                    string_value(record.get("received_at")).and_then(utils::parse_timestamp_ms)
                {
                    return now - received as i64 > ttl;
                }
            }
        }
    }
    tokio::fs::metadata(path)
        .await
        .ok()
        .map(|meta| now - file_mtime_ms(&meta) > ttl)
        .unwrap_or(false)
}

impl<'a> CodexTranscriptEngine<'a> {
    pub async fn index_discovered_transcript_owners(
        &self,
        rt: &InputRuntime,
        files: &[DiscoveredSessionFile],
        skip: Option<&HashSet<String>>,
    ) -> anyhow::Result<()> {
        self.index_transcript_owners(rt, files, skip, false).await
    }

    pub async fn index_targeted_transcript_owners(
        &self,
        rt: &InputRuntime,
        files: &[DiscoveredSessionFile],
    ) -> anyhow::Result<()> {
        self.index_transcript_owners(rt, files, None, true).await
    }

    async fn index_transcript_owners(
        &self,
        rt: &InputRuntime,
        files: &[DiscoveredSessionFile],
        skip: Option<&HashSet<String>>,
        targeted: bool,
    ) -> anyhow::Result<()> {
        let discovered: HashSet<String> = files.iter().map(|file| file.file_path.clone()).collect();
        let kept = self.body.with_shared(|shared| {
            let mut kept = Vec::new();
            if targeted {
                kept.extend(
                    shared
                        .meta_by_path
                        .iter()
                        .filter(|(path, _)| !discovered.contains(*path))
                        .map(|(path, meta)| (path.clone(), meta.clone())),
                );
            }
            if let Some(skip) = skip {
                for path in skip {
                    if let Some(meta) = shared.meta_by_path.get(path).cloned() {
                        kept.push((path.clone(), meta));
                    }
                }
            }
            shared.meta_by_path.clear();
            shared.path_by_thread.clear();
            kept
        });
        if !targeted {
            self.prune_absent_meta_cache(&discovered, now_ms() as i64);
        }
        for (path, meta) in kept {
            self.publish_transcript_owner_meta(&path, meta);
        }
        for file in files {
            if skip.is_some_and(|skip| skip.contains(&file.file_path)) {
                continue;
            }
            let Ok(version) = scan::file_version_snapshot(&file.file_path).await else {
                continue;
            };
            let inode = version.inode;
            let size = version.size;
            let checkpoint = self.read_checkpoint(rt, &self.state_key(&file.file_path));
            let owner = if checkpoint.as_ref().is_some_and(|item| item.inode == inode) {
                if let Some(offset) = checkpoint.and_then(|item| item.owner_session_meta_offset) {
                    Some(offset)
                } else {
                    self.find_owner_offset(rt, &file.file_path, &version, None)
                        .await?
                }
            } else {
                self.find_owner_offset(rt, &file.file_path, &version, None)
                    .await?
            };
            let Some(owner) = owner else {
                continue;
            };
            if let Some(meta) = self
                .load_transcript_owner_meta(rt, &file.file_path, inode, size, owner, false)
                .await?
            {
                self.publish_transcript_owner_meta(&file.file_path, meta);
            }
        }
        Ok(())
    }

    async fn register_subagent_owner_meta(
        &self,
        rt: &InputRuntime,
        file_path: &str,
        inode: u64,
        file_size: i64,
        owner_offset: Option<i64>,
        active: bool,
    ) -> anyhow::Result<()> {
        let Some(owner_offset) = owner_offset else {
            return Ok(());
        };
        let indexed = if active {
            let missing = self
                .body
                .with_shared(|shared| !shared.meta_cache.contains_key(file_path));
            if missing {
                self.body
                    .with_shared(|shared| shared.meta_by_path.get(file_path).cloned())
            } else {
                None
            }
        } else {
            None
        };
        if let Some(meta) = indexed {
            self.remember_transcript_owner_meta(
                file_path,
                inode,
                file_size,
                owner_offset,
                meta.clone(),
                true,
            );
            self.publish_transcript_owner_meta(file_path, meta);
            return Ok(());
        }
        if let Some(meta) = self
            .load_transcript_owner_meta(rt, file_path, inode, file_size, owner_offset, active)
            .await?
        {
            self.publish_transcript_owner_meta(file_path, meta);
        }
        Ok(())
    }

    async fn load_transcript_owner_meta(
        &self,
        rt: &InputRuntime,
        file_path: &str,
        inode: u64,
        file_size: i64,
        owner_offset: i64,
        active: bool,
    ) -> anyhow::Result<Option<CodexTranscriptMeta>> {
        let cached = self.body.with_shared(|shared| {
            shared.meta_cache.get(file_path).and_then(|cached| {
                if reusable_cached(cached, inode, file_size, owner_offset) {
                    Some(cached.meta.clone())
                } else {
                    None
                }
            })
        });
        if let Some(meta) = cached {
            self.body.with_shared(|shared| {
                if active {
                    if let Some(mut cached) = shared.meta_cache.shift_remove(file_path) {
                        cached.file_size = file_size;
                        cached.last_seen_at_ms = now_ms() as i64;
                        shared.meta_cache.insert(file_path.to_owned(), cached);
                    }
                } else if let Some(cached) = shared.meta_cache.get_mut(file_path) {
                    // Discovery refreshes the witness, but only active consumption
                    // promotes metadata in the bounded LRU working set.
                    cached.file_size = file_size;
                    cached.last_seen_at_ms = now_ms() as i64;
                }
            });
            return Ok(Some(meta));
        }
        self.remove_meta_cache(file_path);
        if owner_offset < 0 || owner_offset >= file_size {
            return Ok(None);
        }
        let Some(record) = read_json_line_at(file_path, owner_offset, Some(rt)).await? else {
            return Ok(None);
        };
        let Some(meta) = extract_codex_transcript_meta(&record) else {
            return Ok(None);
        };
        self.remember_transcript_owner_meta(
            file_path,
            inode,
            file_size,
            owner_offset,
            meta.clone(),
            active,
        );
        Ok(Some(meta))
    }

    fn remember_transcript_owner_meta(
        &self,
        file_path: &str,
        inode: u64,
        file_size: i64,
        owner_offset: i64,
        meta: CodexTranscriptMeta,
        active: bool,
    ) {
        self.remove_meta_cache(file_path);
        let estimated = file_path.len()
            + serde_json::to_vec(&meta)
                .map(|bytes| bytes.len())
                .unwrap_or(0);
        if estimated > MAX_CACHED_TRANSCRIPT_META_BYTES {
            return;
        }
        let blocked = self.body.with_shared(|shared| {
            !active
                && (shared.meta_cache.len() >= MAX_LINK_DESCRIPTORS
                    || shared.meta_cache_bytes + estimated > MAX_CACHED_TRANSCRIPT_META_BYTES)
        });
        if blocked {
            return;
        }
        self.body.with_shared(|shared| {
            shared.meta_cache.insert(
                file_path.to_owned(),
                CachedMeta {
                    inode,
                    file_size,
                    owner_offset,
                    meta,
                    estimated_bytes: estimated,
                    last_seen_at_ms: now_ms() as i64,
                },
            );
            shared.meta_cache_bytes += estimated;
            while shared.meta_cache.len() > MAX_LINK_DESCRIPTORS
                || shared.meta_cache_bytes > MAX_CACHED_TRANSCRIPT_META_BYTES
            {
                if let Some((_, cached)) = shared.meta_cache.shift_remove_index(0) {
                    shared.meta_cache_bytes = shared
                        .meta_cache_bytes
                        .saturating_sub(cached.estimated_bytes);
                } else {
                    break;
                }
            }
        });
    }

    fn cached_meta_for_checkpoint(
        &self,
        file_path: &str,
        checkpoint: &CodexTranscriptCheckpoint,
        file_size: i64,
    ) -> Option<CodexTranscriptMeta> {
        let owner = checkpoint.owner_session_meta_offset?;
        self.body.with_shared(|shared| {
            let cached = shared.meta_cache.shift_remove(file_path)?;
            if !reusable_cached(&cached, checkpoint.inode, file_size, owner) {
                shared.meta_cache.insert(file_path.to_owned(), cached);
                return None;
            }
            let meta = cached.meta.clone();
            let mut cached = cached;
            cached.file_size = file_size;
            cached.last_seen_at_ms = now_ms() as i64;
            shared.meta_cache.insert(file_path.to_owned(), cached);
            Some(meta)
        })
    }

    fn prune_absent_meta_cache(&self, discovered: &HashSet<String>, now: i64) {
        self.body.with_shared(|shared| {
            let stale: Vec<String> = shared
                .meta_cache
                .iter()
                .filter(|(path, cached)| {
                    !discovered.contains(*path)
                        && now - cached.last_seen_at_ms >= CACHED_TRANSCRIPT_META_ABSENCE_TTL_MS
                })
                .map(|(path, _)| path.clone())
                .collect();
            for path in stale {
                if let Some(cached) = shared.meta_cache.shift_remove(&path) {
                    shared.meta_cache_bytes = shared
                        .meta_cache_bytes
                        .saturating_sub(cached.estimated_bytes);
                }
            }
        });
    }

    fn remove_meta_cache(&self, file_path: &str) {
        self.body.with_shared(|shared| {
            if let Some(cached) = shared.meta_cache.shift_remove(file_path) {
                shared.meta_cache_bytes = shared
                    .meta_cache_bytes
                    .saturating_sub(cached.estimated_bytes);
            }
        });
    }

    fn publish_transcript_owner_meta(&self, file_path: &str, meta: CodexTranscriptMeta) {
        self.body.with_shared(|shared| {
            if let Some(previous) = shared.meta_by_path.get(file_path) {
                if previous.thread_id != meta.thread_id
                    && shared
                        .path_by_thread
                        .get(&previous.thread_id)
                        .map(String::as_str)
                        == Some(file_path)
                {
                    shared.path_by_thread.shift_remove(&previous.thread_id);
                }
            }
            shared
                .path_by_thread
                .insert(meta.thread_id.clone(), file_path.to_owned());
            shared.linker.register_child(&meta);
            shared.meta_by_path.insert(file_path.to_owned(), meta);
        });
    }

    fn register_persisted_subagent_spawns(
        &self,
        checkpoint: &CodexTranscriptCheckpoint,
        parent_thread_id: &str,
    ) {
        let Some(active) = checkpoint.active_turn.as_ref() else {
            return;
        };
        if active.subagent_spawns.is_empty() {
            return;
        }
        let spawns = active
            .subagent_spawns
            .iter()
            .map(|spawn| CodexSpawnDescriptor {
                parent_thread_id: parent_thread_id.to_owned(),
                parent_turn_id: active.turn_id.clone(),
                parent_trace_id: spawn.parent_trace_id.clone(),
                parent_tool_call_id: spawn.parent_tool_call_id.clone(),
                spawned_at_ms: spawn.spawned_at_ms,
                task_name: spawn.task_name.clone(),
                agent_path: spawn.agent_path.clone(),
                child_thread_id: spawn.child_thread_id.clone(),
                ..Default::default()
            })
            .collect::<Vec<_>>();
        self.body
            .with_shared(|shared| shared.linker.register_spawns(&spawns));
    }

    async fn release_parent_fusion_independently(
        &self,
        rt: &InputRuntime,
        file_path: &str,
        checkpoint: &mut CodexTranscriptCheckpoint,
    ) -> anyhow::Result<(usize, usize)> {
        #[cfg(test)]
        if let Some(observer) = self
            .body
            .with_shared(|shared| shared.main543_legacy_release_observer.clone())
        {
            observer("release_parent_fusion_independently");
        }

        let Some(pending) = checkpoint.pending_fusion.clone() else {
            return Ok((0, 0));
        };
        checkpoint.scan_offset = checkpoint.scan_offset.max(pending.terminal_end_offset);
        checkpoint.pending_fusion = None;
        let meta = json!({ "transcriptPath": file_path, "turnId": pending.turn_id });
        rt.warn(
            "Codex parent fusion has no reliable child candidates; emitting independently",
            meta.as_object(),
        );
        if checkpoint.active_turn.is_none() {
            return Ok((0, 0));
        }
        let recovered = self
            .recover_turn_segment(
                rt,
                file_path,
                checkpoint,
                RecoveryBoundary {
                    end_offset: pending.terminal_end_offset,
                    terminal: true,
                    inferred: None,
                    next_turn_started_at_ms: None,
                },
                None,
            )
            .await?;
        if matches!(recovered.kind, RecoveryKind::Unparseable) {
            checkpoint.pending_terminal = Some(new_pending_terminal(
                pending.turn_id,
                pending.terminal_end_offset,
                recovered.diagnostics.source_record_count as u64,
            ));
            return Ok((0, 0));
        }
        let emitted = self.body.emit_batches(recovered.entries);
        checkpoint.active_turn = None;
        checkpoint.pending_terminal = None;
        Ok((emitted, 1))
    }

    async fn release_captured_subagent_independently(
        &self,
        rt: &InputRuntime,
        file_path: &str,
        checkpoint: &mut CodexTranscriptCheckpoint,
    ) -> anyhow::Result<(usize, usize)> {
        #[cfg(test)]
        if let Some(observer) = self
            .body
            .with_shared(|shared| shared.main543_legacy_release_observer.clone())
        {
            observer("release_captured_subagent_independently");
        }

        let Some(captured) = checkpoint.pending_subagent.clone() else {
            return Ok((0, 0));
        };
        let mut recovery = checkpoint.clone();
        recovery.active_turn = Some(captured.active_turn.clone());
        recovery.pending_subagent = None;
        let recovered = self
            .recover_turn_segment(
                rt,
                file_path,
                &mut recovery,
                RecoveryBoundary {
                    end_offset: captured.terminal_end_offset,
                    terminal: true,
                    inferred: None,
                    next_turn_started_at_ms: None,
                },
                None,
            )
            .await?;
        if matches!(recovered.kind, RecoveryKind::Unparseable) {
            let meta = json!({
                "transcriptPath": file_path,
                "turnId": captured.turn_id,
                "parentToolCallId": captured.parent_tool_call_id,
            });
            rt.warn(
                "captured Codex child could not be rebuilt for independent fallback",
                meta.as_object(),
            );
            return Ok((0, 0));
        }
        let emitted = self.body.emit_batches(recovered.entries);
        checkpoint.pending_subagent = None;
        Ok((emitted, 1))
    }

    pub fn restore_delegation_state(&self, rt: &InputRuntime) {
        if let Some(extra) = rt.state_store.get("codex-transcript").extra() {
            self.body.with_shared(|shared| {
                shared.linker.restore(&extra["codexDelegations"]);
                if let Some(ids) = extra["codexResultInvocations"].as_array() {
                    for id in ids
                        .iter()
                        .filter_map(Value::as_str)
                        .take(MAX_LINK_DESCRIPTORS)
                    {
                        shared.delivered_invocations.insert(id.to_owned());
                    }
                }
                if let Some(results) = extra["codexPendingAgentResults"].as_array() {
                    for value in results {
                        if let Ok(pending) = serde_json::from_value::<
                            super::super::invocation_audit::PendingAgentResult,
                        >(value.clone())
                        {
                            if pending.start_offset >= 0
                                && pending.end_offset > pending.start_offset
                                && !pending.context.session_id.is_empty()
                                && !pending.context.event_id.is_empty()
                            {
                                shared.pending_agent_results.insert(
                                    format!("{}:{}", pending.file_path, pending.start_offset),
                                    pending,
                                );
                            }
                        }
                    }
                }
                while shared.pending_agent_results.len() > MAX_LINK_DESCRIPTORS {
                    shared.pending_agent_results.shift_remove_index(0);
                }
            });
        }
    }

    pub(super) fn save_delegation_state(&self, rt: &InputRuntime) {
        let extra = self.body.with_shared(|shared| json!({
            "codexDelegations": shared.linker.serialize(),
            "codexResultInvocations": shared.delivered_invocations,
            "codexPendingAgentResults": shared.pending_agent_results.values().collect::<Vec<_>>(),
        }));
        let previous = rt.state_store.get("codex-transcript").extra();
        let empty_delegations = [
            "spawns",
            "children",
            "bindings",
            "completedWorkResults",
            "workTerminals",
        ]
        .iter()
        .all(|key| {
            extra["codexDelegations"][*key]
                .as_array()
                .is_none_or(Vec::is_empty)
        });
        let same = [
            "codexDelegations",
            "codexResultInvocations",
            "codexPendingAgentResults",
        ]
        .iter()
        .all(|key| {
            let before = previous.as_ref().and_then(|p| p.get(*key));
            before == Some(&extra[*key])
                || (before.is_none()
                    && if *key == "codexDelegations" {
                        empty_delegations
                    } else {
                        extra[*key].as_array().is_some_and(Vec::is_empty)
                    })
        });
        if same {
            return;
        }
        rt.state_store.update(
            "codex-transcript",
            InputStatePatch {
                extra: Some(extra),
                ..Default::default()
            },
        );
    }

    pub async fn retry_pending_agent_results(&self, rt: &InputRuntime) -> anyhow::Result<usize> {
        #[cfg(test)]
        self.body.with_shared(|s| s.main541_retries += 1);
        let pending = self.body.with_shared(|shared| {
            shared
                .pending_agent_results
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect::<Vec<_>>()
        });
        let mut emitted = 0;
        for (key, pending) in pending {
            let stat = file_meta_snapshot(&pending.file_path).await.ok();
            let valid = stat
                .as_ref()
                .is_some_and(|(ino, size, _)| *ino == pending.inode && *size >= pending.end_offset);
            if !valid {
                continue;
            }
            let read = read_json_lines(
                &pending.file_path,
                pending.start_offset,
                pending.end_offset,
                Some(rt),
            )
            .await?;
            let sources: Vec<_> = read
                .items
                .into_iter()
                .map(|line| CodexTranscriptSourceRecord {
                    start_offset: line.start_offset,
                    end_offset: line.end_offset,
                    record: line.record,
                })
                .collect();
            let output = self.body.with_shared(|shared| {
                let known = shared
                    .linker
                    .get_delegations_for_parent(&pending.context.session_id);
                shared.pending_agent_results.shift_remove(&key);
                super::super::invocation_audit::append_agent_results(
                    Vec::new(),
                    &sources,
                    &known,
                    super::super::invocation_audit::ResultContext {
                        receiving_session: &pending.context.session_id,
                        delivered: &mut shared.delivered_invocations,
                        fallback: &pending.context,
                        pending: &mut shared.pending_agent_results,
                        file_path: &pending.file_path,
                        inode: pending.inode,
                    },
                )
            });
            emitted += self.body.emit_batches(output);
        }
        self.save_delegation_state(rt);
        Ok(emitted)
    }

    pub fn report_subagent_links(&self, rt: &InputRuntime) {
        let snapshot = self.body.with_shared(|shared| shared.linker.snapshot());
        if snapshot.detected_children == 0 && snapshot.detected_spawns == 0 {
            return;
        }
        let summary = format!(
            "{}:{}:{}:{}",
            snapshot.detected_children,
            snapshot.detected_spawns,
            snapshot.linked_children,
            snapshot.orphan_children
        );
        let changed = self.body.with_shared(|shared| {
            if shared.last_summary == summary {
                false
            } else {
                shared.last_summary = summary;
                true
            }
        });
        if changed {
            let meta = json!({
                "detectedChildren": snapshot.detected_children,
                "detectedSpawns": snapshot.detected_spawns,
                "linkedChildren": snapshot.linked_children,
                "orphanChildren": snapshot.orphan_children,
            });
            rt.info("Codex subagent linker summary", meta.as_object());
        }
        for link in snapshot.links {
            let fingerprint = format!(
                "{}:{}:{}",
                link.confidence.as_str(),
                link.parent_tool_call_id.as_deref().unwrap_or(""),
                link.orphan_reason
                    .map(|reason| reason.as_str())
                    .unwrap_or("")
            );
            let fresh = self.body.with_shared(|shared| {
                if shared
                    .reported
                    .get(&link.child_thread_id)
                    .map(String::as_str)
                    == Some(fingerprint.as_str())
                {
                    return false;
                }
                shared.reported.shift_remove(&link.child_thread_id);
                shared
                    .reported
                    .insert(link.child_thread_id.clone(), fingerprint);
                while shared.reported.len() > MAX_LINK_DESCRIPTORS {
                    shared.reported.shift_remove_index(0);
                }
                true
            });
            if fresh {
                let meta = json!({
                    "childThreadId": link.child_thread_id,
                    "parentThreadId": link.parent_thread_id,
                    "parentTurnId": link.parent_turn_id,
                    "parentToolCallId": link.parent_tool_call_id,
                    "agentPath": link.agent_path,
                    "confidence": link.confidence.as_str(),
                    "orphanReason": link.orphan_reason.map(|reason| reason.as_str()),
                });
                rt.debug("Codex subagent link resolved", meta.as_object());
            }
        }
    }
}

fn reusable_cached(cached: &CachedMeta, inode: u64, file_size: i64, owner_offset: i64) -> bool {
    cached.inode == inode
        && cached.owner_offset == owner_offset
        && file_size >= cached.file_size
        && owner_offset >= 0
        && owner_offset < file_size
}

struct DeferredRecovery {
    changed: bool,
    emitted_count: usize,
    processed_terminal_count: usize,
}
fn owner_probe_key(path: &str, version: &scan::FileVersion, end: i64) -> String {
    format!("{}\0{}\0{}", path, source_version(version), end)
}
fn source_version(version: &scan::FileVersion) -> String {
    let modified = version
        .modified
        .map(|time| match time.duration_since(std::time::UNIX_EPOCH) {
            Ok(duration) => {
                duration.as_secs() as f64 * 1000.0 + duration.subsec_nanos() as f64 / 1_000_000.0
            }
            Err(error) => -error.duration().as_secs_f64() * 1000.0,
        })
        .unwrap_or(0.0);
    #[cfg(unix)]
    let changed = version.changed.0 as f64 * 1000.0 + version.changed.1 as f64 / 1_000_000.0;
    #[cfg(windows)]
    let changed = (version.changed.0 - 116_444_736_000_000_000_i64) as f64 / 10_000.0;
    format!(
        "{}:{}:{}:{}:{}",
        version.device, version.inode, version.size, modified, changed
    )
}
impl CodexTranscriptEngine<'_> {
    async fn find_owner_offset(
        &self,
        rt: &InputRuntime,
        file_path: &str,
        version: &scan::FileVersion,
        end_offset: Option<i64>,
    ) -> anyhow::Result<Option<i64>> {
        #[cfg(test)]
        self.body
            .with_shared(|shared| shared.main543_owner_probe_calls += 1);
        let end = end_offset.unwrap_or(version.size);
        // NUL cannot occur in a filesystem path; include the requested boundary
        // because a short prefix cannot establish absence beyond that prefix.
        let key = owner_probe_key(file_path, version, end);
        let previous = self
            .body
            .with_shared(|shared| shared.owner_offset_probes.get_copied(&key));
        let state_key = self.state_key(file_path);
        let version_key = source_version(version);
        let absent_version = rt
            .state_store
            .get(&state_key)
            .extra()
            .and_then(|extra| extra.get("codexOwnerAbsentVersion").cloned());
        // A full stable negative belongs to this file's checkpoint, outside the
        // bounded shared LRU. It neither advances a cursor nor skips recovery.
        if end == version.size
            && absent_version
                .as_ref()
                .and_then(Value::as_str)
                .is_some_and(|known| known.len() <= 256 && known == version_key)
        {
            return Ok(None);
        }
        if let Some(cached) = previous {
            return Ok(cached);
        }
        let (offset, complete) =
            scan::find_owner_session_meta_probe(file_path, end, Some(rt)).await?;
        #[cfg(test)]
        if let Some(observer) = self
            .body
            .with_shared(|shared| shared.main543_probe_after_read.clone())
        {
            observer(file_path);
        }
        let Ok(after) = scan::file_version_snapshot(file_path).await else {
            return Ok(None);
        };
        if &after != version {
            return Ok(None);
        }
        self.body.with_shared(|shared| {
            shared.owner_offset_probes.set_verified(
                key,
                offset,
                complete.then_some((*version, end)),
            )
        });
        if offset.is_none() && complete && end == version.size {
            rt.state_store.update(
                &state_key,
                InputStatePatch {
                    extra: Some(json!({"codexOwnerAbsentVersion": version_key})),
                    ..InputStatePatch::default()
                },
            );
        } else if offset.is_some() {
            let current = rt.state_store.get(&state_key);
            if let Some(mut extra) = current.extra() {
                if extra
                    .as_object_mut()
                    .is_some_and(|object| object.remove("codexOwnerAbsentVersion").is_some())
                {
                    rt.state_store.set(&state_key, current.with_extra(extra));
                }
            }
        }
        Ok(offset)
    }
}

#[cfg(test)]
#[path = "engine_history.rs"]
mod history_contracts;
