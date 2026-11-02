//! Port of `src/inputs/qoder-cn-trace/qoder-cn-trace-input.ts`.
//!
//! Orphan turns (no user `other` event) are renumbered onto the previous anchor
//! turn for that session. CLI sessions are those carrying `agent.client_request_id`.
//! IDE sessions use the CN SQLite candidates and never relabel agent type from
//! the matched database path.

use crate::inputs::base::{
    build_canonical_hook_entry, create_hook_history_startup_checkpoint,
    filter_bootstrap_history_turns, CanonicalHookRecordOptions, InputBody, InputRuntime,
};
use crate::inputs::qoder_trace::{
    collect_cli_expected_request_ids, enrich_cli_from_segments, enrich_cli_primary,
    enrich_ide_turn, inject_trace_id, read_intercept_data, read_segment_tokens_for_session,
    read_sqlite_tokens, resolve_qoder_cn_db_paths, QODER_CN_SEGMENTS_ROOT,
};
use crate::normalization::enrich_canonical_entry_with_git;
use crate::types::{AgentActivityEntry, ClientType, CollectionMethod};
use crate::utils::{
    directory_exists, ensure_dir, get_today_date_string, resolve_home, DEFAULT_POLL_INTERVAL_MS,
};
use async_trait::async_trait;
use regex::Regex;
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex};

static STEP_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r":s(\d+)$").expect("step"));

pub struct QoderCnTraceOptions {
    pub state_store: Arc<crate::checkpoints::StateStore>,
    pub log_dir: Option<String>,
    pub poll_interval_ms: Option<u64>,
}

pub struct QoderCnTraceInput {
    inner: Arc<crate::inputs::base::HostedInput<QoderCnTraceBody>>,
}

struct Anchor {
    turn_id: String,
    max_step: i64,
}

struct QoderCnTraceBody {
    log_dir: String,
    anchors: Mutex<HashMap<String, Anchor>>,
}

impl QoderCnTraceInput {
    pub(crate) fn collector_runtime_info(&self) -> crate::inputs::base::InputRuntimeInfo {
        self.inner.runtime.runtime_info()
    }

    /// Apply validated collector exclusions before any collection or upload.
    pub(crate) fn set_collector_workspace_policy(
        &self,
        policy: crate::inputs::base::WorkspacePolicy,
    ) {
        self.inner.runtime.set_workspace_policy(policy);
    }

    /// Collector subscription. Forwards to the hosted runtime without exposing its body type.
    pub fn bind_collector(
        &self,
        on_entries: impl Fn(&[crate::types::AgentActivityEntry]) + Send + Sync + 'static,
        on_delta: impl Fn(&crate::inputs::base::InputRuntimeDelta) + Send + Sync + 'static,
    ) {
        self.inner.on_entries(on_entries);
        self.inner.on_runtime_delta(on_delta);
    }

    pub fn collector_running(&self) -> bool {
        self.inner.running()
    }

    pub fn new(opts: QoderCnTraceOptions) -> Self {
        Self {
            inner: crate::inputs::base::HostedInput::new(
                QoderCnTraceBody {
                    log_dir: opts.log_dir.unwrap_or_else(|| {
                        resolve_home("~/.loongsuite-pilot/logs/qoder-cn/history")
                    }),
                    anchors: Mutex::new(HashMap::new()),
                },
                "QoderCnTraceInput",
                opts.state_store,
                opts.poll_interval_ms.or(Some(DEFAULT_POLL_INTERVAL_MS)),
            ),
        }
    }
    pub async fn start(&self) -> Result<(), String> {
        self.inner.start().await
    }
    pub async fn stop(&self) -> Result<(), String> {
        self.inner.stop().await
    }
    pub async fn check_availability() -> bool {
        directory_exists(&resolve_home("~/.qoder-cn")).await
    }
    pub fn get_watch_paths() -> Vec<String> {
        vec![resolve_home("~/.loongsuite-pilot/logs/qoder-cn/history")]
    }
}

#[async_trait]
impl InputBody for QoderCnTraceBody {
    fn checkpoint_namespaces(&self) -> Option<Vec<String>> {
        Some(vec![self.id().to_owned()])
    }

    fn id(&self) -> &str {
        "qoder-cn-trace"
    }
    fn agent_type(&self) -> ClientType {
        ClientType::QoderCn
    }
    fn collection_method(&self) -> CollectionMethod {
        CollectionMethod::HookJsonl
    }

    async fn on_start(&self, rt: &InputRuntime) -> anyhow::Result<()> {
        ensure_dir(&self.log_dir).await;
        let state = rt.state();
        if let Some(checkpoint) =
            create_hook_history_startup_checkpoint(&state, &self.log_dir, "qoder-cn").await?
        {
            rt.set_state_fields(
                Some(checkpoint.last_file),
                Some(checkpoint.last_offset),
                Some(checkpoint.extra),
            );
            if checkpoint.skipped_existing_bytes > 0 {
                rt.warn(
                    "history checkpoint missing, baselining existing file without replay",
                    serde_json::json!({ "skippedBytes": checkpoint.skipped_existing_bytes })
                        .as_object(),
                );
            } else {
                rt.info(
                    "history checkpoint initialized before first hook record",
                    None,
                );
            }
        }
        Ok(())
    }

    async fn collect(&self, rt: &InputRuntime) -> anyhow::Result<Vec<AgentActivityEntry>> {
        let mut raw = read_today(&self.log_dir, rt).await?;
        if raw.is_empty() {
            return Ok(Vec::new());
        }
        merge_orphans(&mut raw, &self.anchors);
        let mut by_session: HashMap<String, Vec<usize>> = HashMap::new();
        let mut no_session = Vec::new();
        let turns = group(&raw);
        for indexes in turns.values() {
            dedupe_turn(&mut raw, indexes);
        }
        raw.retain(|entry| entry.extra.get("__deduped").and_then(Value::as_bool) != Some(true));
        for entry in &mut raw {
            entry.extra.remove("__deduped");
        }
        let regrouped = group(&raw);
        for indexes in regrouped.values() {
            match extract_session(&raw, indexes) {
                Some(session) => by_session
                    .entry(session)
                    .or_default()
                    .extend(indexes.iter().copied()),
                None => no_session.extend(indexes.iter().copied()),
            }
        }
        let mut intercept = None;
        for (session, indexes) in &by_session {
            let slice: Vec<AgentActivityEntry> =
                indexes.iter().map(|index| raw[*index].clone()).collect();
            let mut slice = slice;
            if has_client_request_id(&slice) {
                let expected = collect_cli_expected_request_ids(&slice);
                let segments =
                    read_segment_tokens_for_session(session, &expected, QODER_CN_SEGMENTS_ROOT)
                        .await;
                if intercept.is_none() {
                    intercept =
                        Some(read_intercept_data(None, Some("qoderclicn-intercept.jsonl")).await);
                }
                let data = intercept.as_ref().unwrap();
                enrich_cli_primary(
                    &mut slice,
                    data.system_prompt
                        .as_ref()
                        .map(|prompt| prompt.content.as_str()),
                    &data.tokens,
                );
                if !segments.is_empty() {
                    enrich_cli_from_segments(&mut slice, &segments);
                }
            } else {
                let result = read_sqlite_tokens(session, &resolve_qoder_cn_db_paths()).await;
                enrich_ide_turn(&mut slice, &result.rows);
            }
            expand_container_times(&mut slice);
            propagate_model(&mut slice);
            compute_tool_durations(&mut slice);
            align_user_boundary(&mut slice);
            for (pos, index) in indexes.iter().enumerate() {
                raw[*index] = slice[pos].clone();
            }
        }
        let mut ordered = Vec::new();
        for indexes in group(&raw).values() {
            let mut slice: Vec<_> = indexes.iter().map(|index| raw[*index].clone()).collect();
            if no_session.iter().any(|index| indexes.contains(index)) {
                dedupe_owned(&mut slice);
            }
            inject_trace_id(&mut slice);
            ordered.extend(slice);
        }
        let _ = no_session;
        Ok(ordered)
    }
}

fn merge_orphans(entries: &mut [AgentActivityEntry], anchors: &Mutex<HashMap<String, Anchor>>) {
    let mut guard = anchors.lock().unwrap_or_else(|err| err.into_inner());
    let groups = group(entries);
    for (turn_id, indexes) in groups {
        let Some(session) = extract_session(entries, &indexes) else {
            continue;
        };
        let has_user = indexes.iter().any(|index| {
            is_name(&entries[*index], "other") && entries[*index].input_messages_delta.is_some()
        });
        if has_user {
            let mut max_step = 0;
            for index in &indexes {
                if let Some(step) = entries[*index].step_id.as_deref() {
                    if let Some(caps) = STEP_RE.captures(step) {
                        if let Ok(n) = caps[1].parse::<i64>() {
                            max_step = max_step.max(n);
                        }
                    }
                }
            }
            guard.insert(session, Anchor { turn_id, max_step });
        } else if let Some(anchor) = guard.get_mut(&session) {
            let mut step_ids: Vec<String> = indexes
                .iter()
                .filter_map(|index| entries[*index].step_id.clone())
                .filter(|id| !id.is_empty())
                .collect();
            step_ids.sort();
            step_ids.dedup();
            let mut remap = HashMap::new();
            for step in step_ids {
                anchor.max_step += 1;
                remap.insert(step, format!("{}:s{}", anchor.turn_id, anchor.max_step));
            }
            let new_turn = anchor.turn_id.clone();
            for index in indexes {
                entries[index].turn_id = Some(new_turn.clone());
                if let Some(step) = entries[index].step_id.clone() {
                    if let Some(mapped) = remap.get(&step) {
                        entries[index].step_id = Some(mapped.clone());
                    }
                }
            }
        }
    }
}

fn dedupe_turn(entries: &mut [AgentActivityEntry], indexes: &[usize]) {
    let mut last: HashMap<String, usize> = HashMap::new();
    for index in indexes {
        let key = format!(
            "{}|{}|{}",
            entries[*index].step_id.as_deref().unwrap_or(""),
            entries[*index].event_name.map(|n| n.as_str()).unwrap_or(""),
            entries[*index].tool_call_id.as_deref().unwrap_or("")
        );
        last.insert(key, *index);
    }
    let keep: std::collections::HashSet<usize> = last.into_values().collect();
    for index in indexes {
        if !keep.contains(index) {
            entries[*index]
                .extra
                .insert("__deduped".into(), serde_json::json!(true));
        }
    }
}

fn dedupe_owned(entries: &mut Vec<AgentActivityEntry>) {
    let mut last = HashMap::new();
    for (index, entry) in entries.iter().enumerate() {
        let key = format!(
            "{}|{}|{}",
            entry.step_id.as_deref().unwrap_or(""),
            entry.event_name.map(|n| n.as_str()).unwrap_or(""),
            entry.tool_call_id.as_deref().unwrap_or("")
        );
        last.insert(key, index);
    }
    let keep: std::collections::HashSet<usize> = last.into_values().collect();
    let mut index = 0;
    entries.retain(|_| {
        let keep_this = keep.contains(&index);
        index += 1;
        keep_this
    });
}

fn align_user_boundary(entries: &mut [AgentActivityEntry]) {
    let turns = group(entries);
    for indexes in turns.values() {
        let Some(first) = indexes.iter().copied().find(|&index| {
            is_name(&entries[index], "llm.request") && entries[index].step_id.is_some()
        }) else {
            continue;
        };
        let nano = entries[first].time_unix_nano.clone();
        let step = entries[first].step_id.clone();
        let model = entries[first].request_model.clone();
        let provider = entries[first].provider_name.clone();
        if nano.is_empty() {
            continue;
        }
        for index in indexes {
            if is_name(&entries[*index], "other")
                && entries[*index]
                    .step_id
                    .as_ref()
                    .is_none_or(|id| id.is_empty())
            {
                entries[*index].time_unix_nano = nano.clone();
                entries[*index].step_id = step.clone();
                if model.as_ref().is_some_and(|model| model != "unknown") {
                    entries[*index].request_model = model.clone();
                    entries[*index].response_model = model.clone();
                }
                if provider != "unknown" && !provider.is_empty() {
                    entries[*index].provider_name = provider.clone();
                }
            }
        }
    }
}

fn propagate_model(entries: &mut [AgentActivityEntry]) {
    let mut by_step: HashMap<String, Vec<usize>> = HashMap::new();
    for (index, entry) in entries.iter().enumerate() {
        if let Some(step) = entry.step_id.clone().filter(|id| !id.is_empty()) {
            by_step.entry(step).or_default().push(index);
        }
    }
    for indexes in by_step.values() {
        let Some(resp) = indexes
            .iter()
            .copied()
            .find(|&index| is_name(&entries[index], "llm.response"))
        else {
            continue;
        };
        let model = entries[resp].request_model.clone();
        let response_model = entries[resp].response_model.clone();
        let provider = entries[resp].provider_name.clone();
        if model
            .as_ref()
            .is_none_or(|model| model == "unknown" || model.is_empty())
        {
            continue;
        }
        for index in indexes {
            if !is_name(&entries[*index], "tool.call") && !is_name(&entries[*index], "tool.result")
            {
                continue;
            }
            if entries[*index]
                .request_model
                .as_ref()
                .is_none_or(|model| model.is_empty() || model == "unknown")
            {
                entries[*index].request_model = model.clone();
                if response_model
                    .as_ref()
                    .is_some_and(|model| model != "unknown")
                {
                    entries[*index].response_model = response_model.clone();
                }
                if provider != "unknown" {
                    entries[*index].provider_name = provider.clone();
                }
            }
        }
    }
}

fn compute_tool_durations(entries: &mut [AgentActivityEntry]) {
    let mut calls = HashMap::new();
    for entry in entries.iter() {
        if !is_name(entry, "tool.call") {
            continue;
        }
        if let Some(ns) = parse_nanos(&entry.time_unix_nano) {
            calls.insert(
                format!(
                    "{}|{}",
                    entry.step_id.as_deref().unwrap_or(""),
                    entry.tool_call_id.as_deref().unwrap_or("")
                ),
                ns,
            );
        }
    }
    for entry in entries.iter_mut() {
        if !is_name(entry, "tool.result") {
            continue;
        }
        let Some(result) = parse_nanos(&entry.time_unix_nano) else {
            continue;
        };
        let key = format!(
            "{}|{}",
            entry.step_id.as_deref().unwrap_or(""),
            entry.tool_call_id.as_deref().unwrap_or("")
        );
        if let Some(call) = calls.get(&key) {
            if result >= *call {
                entry.tool_call_duration = Some(((result - call) / 1_000_000) as f64);
            }
        }
    }
}

fn expand_container_times(entries: &mut [AgentActivityEntry]) {
    let turns = group(entries);
    for indexes in turns.values() {
        let max = indexes
            .iter()
            .filter_map(|index| parse_nanos(&entries[*index].time_unix_nano))
            .max()
            .unwrap_or(0);
        for index in indexes {
            let name = entries[*index].event_name.map(|n| n.as_str()).unwrap_or("");
            if matches!(
                name,
                "llm.request" | "llm.response" | "tool.call" | "tool.result" | "other"
            ) {
                continue;
            }
            if parse_nanos(&entries[*index].time_unix_nano).unwrap_or(0) < max {
                entries[*index].time_unix_nano = max.to_string();
            }
        }
    }
}

fn has_client_request_id(entries: &[AgentActivityEntry]) -> bool {
    entries.iter().any(|entry| {
        entry
            .extra
            .get("agent.client_request_id")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.is_empty())
    })
}

fn group(entries: &[AgentActivityEntry]) -> HashMap<String, Vec<usize>> {
    let mut groups = HashMap::new();
    for (index, entry) in entries.iter().enumerate() {
        let turn = entry
            .turn_id
            .clone()
            .filter(|id| !id.is_empty())
            .unwrap_or_else(|| "unknown".into());
        groups.entry(turn).or_insert_with(Vec::new).push(index);
    }
    groups
}

fn extract_session(entries: &[AgentActivityEntry], indexes: &[usize]) -> Option<String> {
    indexes
        .iter()
        .map(|index| entries[*index].session_id.clone())
        .find(|id| !id.is_empty())
}

fn is_name(entry: &AgentActivityEntry, name: &str) -> bool {
    entry
        .event_name
        .map(|event| event.as_str() == name)
        .unwrap_or(false)
}

fn parse_nanos(value: &str) -> Option<i128> {
    if value.is_empty() || !value.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

async fn read_today(log_dir: &str, rt: &InputRuntime) -> anyhow::Result<Vec<AgentActivityEntry>> {
    let name = format!("qoder-cn-{}.jsonl", get_today_date_string());
    let path = Path::new(log_dir).join(&name);
    let Ok(meta) = tokio::fs::metadata(&path).await else {
        return Ok(Vec::new());
    };
    let state = rt.state();
    let mut offset = if state.last_file() == Some(name.as_str()) {
        state.last_offset().unwrap_or(0.0)
    } else {
        0.0
    };
    if offset > 0.0 && (meta.len() as f64) < offset {
        offset = 0.0;
    }
    if (meta.len() as f64) <= offset {
        return Ok(Vec::new());
    }
    let Some(slice) =
        crate::inputs::base::read_file_slice(path.to_string_lossy().as_ref(), offset as u64)
            .await?
    else {
        return Ok(Vec::new());
    };
    let Some(newline) = slice.bytes.iter().rposition(|b| *b == b'\n') else {
        return Ok(Vec::new());
    };
    rt.set_state_fields(Some(name), Some(offset + newline as f64 + 1.0), None);
    let text = String::from_utf8_lossy(&slice.bytes[..=newline]);
    let mut entries = Vec::new();
    for line in text.split('\n') {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(record) = value.as_object() else {
            continue;
        };
        if let Some(mut entry) = build_canonical_hook_entry(
            record,
            ClientType::QoderCn.as_str(),
            None,
            CanonicalHookRecordOptions {
                preserve_safe_custom_top_level_fields: true,
            },
        ) {
            let _ = enrich_canonical_entry_with_git(&mut entry, record, "qoder-cn").await;
            entries.push(entry);
        }
    }
    Ok(filter_bootstrap_history_turns(entries))
}
