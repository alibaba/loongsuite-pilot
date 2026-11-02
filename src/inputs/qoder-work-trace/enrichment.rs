//! Qoder Work's own loop/iteration protocol; no CN request-id pairing is reused.
use crate::inputs::base::InputRuntime;
use crate::inputs::qoder_work_log::{parse_sdk_log_line, SdkEvent};
use crate::types::{AgentActivityEntry, AgentEventName};
use indexmap::IndexMap;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path};
use std::time::{SystemTime, UNIX_EPOCH};
const MAX_READ: u64 = 16 * 1024 * 1024;
const TTL: i64 = 60 * 60 * 1000;
const MATCH_NS: i128 = 5 * 60 * 1000 * 1_000_000;
#[derive(Default, Clone)]
struct Usage {
    input: Option<i64>,
    output: Option<i64>,
    cache: Option<i64>,
    creation: Option<i64>,
}
impl Usage {
    fn from(data: &Value) -> Self {
        Self {
            input: positive(data, "input_tokens"),
            output: positive(data, "output_tokens"),
            cache: positive(data, "cache_read_input_tokens"),
            creation: positive(data, "cache_creation_input_tokens"),
        }
    }
    fn apply(&self, e: &mut AgentActivityEntry) -> bool {
        if self.input.is_none()
            && self.output.is_none()
            && self.cache.is_none()
            && self.creation.is_none()
        {
            return false;
        }
        if let Some(n) = self.input {
            e.input_tokens = Some(n);
        }
        if let Some(n) = self.output {
            e.output_tokens = Some(n);
        }
        if self.input.is_some() || self.output.is_some() {
            e.total_tokens = Some(
                self.input
                    .unwrap_or(0)
                    .saturating_add(self.output.unwrap_or(0)),
            );
        }
        if let Some(n) = self.cache {
            e.cache_read_input_tokens = Some(n);
        }
        if let Some(n) = self.creation {
            e.cache_creation_input_tokens = Some(n);
        }
        true
    }
}
#[derive(Clone)]
struct Pair {
    turn: String,
    index: Option<f64>,
    start: i128,
    end: i128,
    iteration_start: Option<i128>,
    iteration_end: Option<i128>,
    model: String,
    usage: Usage,
    seen: i64,
}
struct Flight {
    turn: String,
    index: Option<f64>,
    start: i128,
    model: String,
    seen: i64,
}
#[derive(Default)]
struct Iteration {
    turn: String,
    index: Option<f64>,
    request_start: Option<i128>,
    response_end: Option<i128>,
    iteration_start: Option<i128>,
    iteration_end: Option<i128>,
    model: String,
    usage: Usage,
    seen: i64,
}
#[derive(Default)]
struct Tool {
    requested: Option<i128>,
    finished: Option<i128>,
    pre: Vec<(String, i128)>,
    post: Vec<(String, i128)>,
    seen: i64,
}
#[derive(Default)]
struct Session {
    pairs: Vec<Pair>,
    iterations: IndexMap<String, Iteration>,
    flights: HashMap<String, Flight>,
    tools: HashMap<String, Tool>,
    subagents: HashMap<String, i64>,
    directory: Option<(String, i64)>,
    sdk_start: Option<(i64, i64)>,
    sdk_pairs: Vec<(i64, Usage, i64)>,
}
#[derive(Default)]
pub(super) struct WorkState {
    sessions: HashMap<String, Session>,
}
fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
fn positive(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64).filter(|n| *n > 0)
}
fn index(value: &Value) -> Option<f64> {
    value.as_f64().filter(|n| n.is_finite() && *n > 0.0)
}
fn suffix_index(value: &str, separator: &str) -> Option<f64> {
    let tail = value.rsplit_once(separator)?.1;
    if tail.is_empty() || !tail.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    tail.parse::<f64>()
        .ok()
        .filter(|n| n.is_finite() && *n > 0.0)
}
fn iso(value: &str) -> Option<i128> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|d| d.timestamp_millis() as i128 * 1_000_000)
}
fn stamp(e: &AgentActivityEntry) -> Option<i128> {
    e.time_unix_nano.parse().ok()
}
pub(super) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
fn preferred(candidates: &[(String, i128)]) -> Option<i128> {
    candidates
        .iter()
        .min_by_key(|(source, n)| {
            (
                match source.as_str() {
                    "runtime" => 0,
                    "user" => 1,
                    "plugins" => 2,
                    _ => 3,
                },
                *n,
            )
        })
        .map(|(_, n)| *n)
}
impl WorkState {
    pub(super) async fn read_sdk(&mut self, rt: &InputRuntime, root: &str) -> anyhow::Result<()> {
        let mut files = Vec::new();
        let Ok(mut dirs) = tokio::fs::read_dir(root).await else {
            return Ok(());
        };
        while let Some(dir) = dirs.next_entry().await? {
            if !dir.file_type().await?.is_dir() {
                continue;
            }
            let main = dir.path().join("main.log");
            if tokio::fs::metadata(&main).await.is_ok_and(|m| m.is_file()) {
                files.push(main);
                continue;
            }
            if let Ok(mut legacy) = tokio::fs::read_dir(dir.path().join("main")).await {
                while let Some(file) = legacy.next_entry().await? {
                    let name = file.file_name().to_string_lossy().into_owned();
                    if file.file_type().await?.is_file()
                        && name.starts_with("sdk-")
                        && name.ends_with(".log")
                    {
                        files.push(file.path());
                    }
                }
            }
        }
        files.sort();
        for path in files {
            let key = format!("{}:sdk-token:{}", rt.id, path.display());
            for line in read_lines(rt, &key, &path).await? {
                let Some(event) = parse_sdk_log_line(&line) else {
                    continue;
                };
                let seen = now_ms();
                match event {
                    SdkEvent::MessageStart { ts, session_id, .. } if !session_id.is_empty() => {
                        self.sessions.entry(session_id).or_default().sdk_start = Some((ts, seen));
                    }
                    SdkEvent::MessageDelta {
                        session_id,
                        input_tokens,
                        output_tokens,
                        ..
                    } if !session_id.is_empty() => {
                        let session = self.sessions.entry(session_id).or_default();
                        if let Some((start, _)) = session.sdk_start.take() {
                            session.sdk_pairs.push((
                                start,
                                Usage {
                                    input: Some(input_tokens).filter(|n| *n > 0),
                                    output: Some(output_tokens).filter(|n| *n > 0),
                                    ..Default::default()
                                },
                                seen,
                            ));
                        }
                    }
                    _ => {}
                }
            }
        }
        Ok(())
    }
    pub(super) async fn read_segments(
        &mut self,
        rt: &InputRuntime,
        root: &str,
        sid: &str,
        cwd: &str,
    ) -> anyhow::Result<()> {
        // Session IDs are opaque single directory components, never path selectors.
        if sid.is_empty()
            || sid.contains(['/', '\\'])
            || !matches!(
                Path::new(sid).components().next(),
                Some(Component::Normal(_))
            )
        {
            return Ok(());
        }
        let cached = self
            .sessions
            .get_mut(sid)
            .and_then(|s| s.directory.as_mut())
            .map(|(p, seen)| {
                *seen = now_ms();
                p.clone()
            });
        let directory = if let Some(path) = cached {
            Some(path)
        } else {
            let preferred = Path::new(root)
                .join(cwd.replace(['/', '.'], "-"))
                .join(sid)
                .join("segments");
            let found = if tokio::fs::metadata(&preferred)
                .await
                .is_ok_and(|m| m.is_dir())
            {
                Some(preferred)
            } else {
                let mut found = None;
                if let Ok(mut dirs) = tokio::fs::read_dir(root).await {
                    while let Some(dir) = dirs.next_entry().await? {
                        if !dir.file_type().await?.is_dir() {
                            continue;
                        }
                        let candidate = dir.path().join(sid).join("segments");
                        if tokio::fs::metadata(&candidate)
                            .await
                            .is_ok_and(|m| m.is_dir())
                        {
                            found = Some(candidate);
                            break;
                        }
                    }
                }
                found
            };
            found.map(|p| {
                let path = p.to_string_lossy().into_owned();
                self.sessions.entry(sid.into()).or_default().directory =
                    Some((path.clone(), now_ms()));
                path
            })
        };
        let Some(directory) = directory else {
            return Ok(());
        };
        let Ok(mut listing) = tokio::fs::read_dir(directory).await else {
            return Ok(());
        };
        let mut files = Vec::new();
        while let Some(file) = listing.next_entry().await? {
            if file.file_type().await?.is_file()
                && file.file_name().to_string_lossy().ends_with(".jsonl")
            {
                files.push(file.path());
            }
        }
        files.sort();
        for path in files {
            let key = format!("{}:seg:{}", rt.id, path.display());
            for line in read_lines(rt, &key, &path).await? {
                match serde_json::from_str::<Value>(&line) {
                    Ok(event) => self.event(sid, &event),
                    Err(_) => rt.warn("invalid QoderWork segment JSONL line", None),
                }
            }
        }
        self.materialize(sid);
        Ok(())
    }
    fn event(&mut self, sid: &str, event: &Value) {
        let kind = text(event, "type");
        let turn = text(event, "turn_id");
        let loop_id = text(event, "loop_id");
        let request = text(event, "request_id");
        let tool_id = text(event, "tool_call_id");
        let data = &event["data"];
        let seen = now_ms();
        if kind == "turn.started" {
            if !turn.is_empty()
                && (data.get("is_subagent") == Some(&Value::Bool(true))
                    || turn.starts_with("qoderwork-memory-sink"))
            {
                self.sessions
                    .entry(sid.into())
                    .or_default()
                    .subagents
                    .insert(turn.into(), seen);
            }
            return;
        }
        let skipped = turn.starts_with("qoderwork-memory-sink")
            || self
                .sessions
                .get(sid)
                .is_some_and(|s| s.subagents.contains_key(turn));
        if kind != "hook.started" && (turn.is_empty() || skipped) {
            return;
        }
        let Some(nano) = iso(text(event, "ts")) else {
            return;
        };
        let session = self.sessions.entry(sid.into()).or_default();
        match kind {
            "model.request.started"
            | "model.response.completed"
            | "loop.iteration.started"
            | "loop.iteration.finished"
                if !loop_id.is_empty() =>
            {
                let state = session
                    .iterations
                    .entry(loop_id.into())
                    .or_insert_with(|| Iteration {
                        turn: turn.into(),
                        index: index(&data["request_index"]).or_else(|| suffix_index(loop_id, ":")),
                        seen,
                        ..Default::default()
                    });
                state.turn = turn.into();
                state.seen = seen;
                state.index = state
                    .index
                    .or_else(|| index(&data["request_index"]))
                    .or_else(|| suffix_index(loop_id, ":"));
                match kind {
                    "model.request.started" => {
                        state.request_start =
                            Some(state.request_start.map_or(nano, |n| n.min(nano)));
                        if state.model.is_empty() {
                            state.model = text(data, "model").into();
                        }
                    }
                    "model.response.completed" => {
                        if state.response_end.is_none_or(|n| nano >= n) {
                            state.response_end = Some(nano);
                            if !text(data, "model").is_empty() {
                                state.model = text(data, "model").into();
                            }
                            state.usage = Usage::from(data);
                        }
                    }
                    "loop.iteration.started" => {
                        state.iteration_start =
                            Some(state.iteration_start.map_or(nano, |n| n.min(nano)))
                    }
                    "loop.iteration.finished" => {
                        state.iteration_end =
                            Some(state.iteration_end.map_or(nano, |n| n.max(nano)))
                    }
                    _ => {}
                }
            }
            "model.request.started" if !request.is_empty() => {
                session.flights.insert(
                    request.into(),
                    Flight {
                        turn: turn.into(),
                        index: index(&data["request_index"]),
                        start: nano,
                        model: text(data, "model").into(),
                        seen,
                    },
                );
            }
            "model.response.completed" if !request.is_empty() => {
                if let Some(start) = session.flights.remove(request) {
                    session.pairs.push(Pair {
                        turn: start.turn,
                        index: start.index.or_else(|| index(&data["request_index"])),
                        start: start.start,
                        end: nano,
                        iteration_start: None,
                        iteration_end: None,
                        model: if text(data, "model").is_empty() {
                            start.model
                        } else {
                            text(data, "model").into()
                        },
                        usage: Usage::from(data),
                        seen,
                    });
                }
            }
            "tool.requested" | "tool.execution.finished" if !tool_id.is_empty() => {
                let timing = session.tools.entry(tool_id.into()).or_default();
                timing.seen = seen;
                if kind == "tool.requested" {
                    timing.requested = Some(nano);
                } else {
                    timing.finished = Some(nano);
                }
            }
            "hook.started" if !tool_id.is_empty() => {
                let hook = text(data, "hook_event_name");
                if !["PreToolUse", "PostToolUse", "PostToolUseFailure"].contains(&hook) {
                    return;
                }
                let timing = session.tools.entry(tool_id.into()).or_default();
                timing.seen = seen;
                let candidate = (text(data, "source").into(), nano);
                if hook == "PreToolUse" {
                    timing.pre.push(candidate);
                } else {
                    timing.post.push(candidate);
                }
            }
            _ => {}
        }
    }
    fn materialize(&mut self, sid: &str) {
        let Some(s) = self.sessions.get_mut(sid) else {
            return;
        };
        if s.iterations.is_empty() {
            return;
        }

        let ready = s
            .iterations
            .iter()
            .filter_map(|(key, state)| {
                let end = state.response_end?;
                let start = state.request_start.or(state.iteration_start)?;
                Some((
                    key.clone(),
                    Pair {
                        turn: state.turn.clone(),
                        index: state.index,
                        start,
                        end,
                        iteration_start: state.iteration_start,
                        iteration_end: state.iteration_end,
                        model: state.model.clone(),
                        usage: state.usage.clone(),
                        seen: state.seen,
                    },
                ))
            })
            .collect::<Vec<_>>();
        for (key, pair) in ready {
            s.iterations.shift_remove(&key);
            s.pairs.push(pair);
        }
        s.pairs.sort_by(|a, b| match (a.index, b.index) {
            (Some(a), Some(b)) if a != b => a.partial_cmp(&b).unwrap_or(std::cmp::Ordering::Equal),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            _ => a
                .iteration_start
                .unwrap_or(a.start)
                .cmp(&b.iteration_start.unwrap_or(b.start)),
        });
    }
    fn take_pair(
        s: &mut Session,
        turn: Option<&str>,
        request: &AgentActivityEntry,
        response: &AgentActivityEntry,
    ) -> Option<Pair> {
        let step = request
            .step_id
            .as_deref()
            .and_then(|id| suffix_index(id, ":s"));
        let mut found = None;
        if let (Some(turn), Some(step)) = (turn, step) {
            found = s
                .pairs
                .iter()
                .position(|p| p.turn == turn && p.index == Some(step));
            if found.is_none() && s.pairs.iter().any(|p| p.turn == turn && p.index.is_some()) {
                return None;
            }
        }
        if found.is_none() {
            if let Some(turn) = turn {
                found = s.pairs.iter().position(|p| p.turn == turn);
            }
        }
        if found.is_none() {
            if let (Some(start), Some(end)) = (stamp(request), stamp(response)) {
                found = s.pairs.iter().position(|p| {
                    (p.start - start).abs() <= MATCH_NS && (p.end - end).abs() <= MATCH_NS
                });
            }
        }
        found.map(|i| s.pairs.remove(i))
    }
    pub(super) fn enrich(&mut self, entries: &mut [AgentActivityEntry]) {
        let sid = entries
            .iter()
            .map(|e| e.session_id.as_str())
            .find(|s| !s.is_empty())
            .unwrap_or("")
            .to_owned();
        let turn = entries
            .iter()
            .filter_map(|e| e.turn_id.as_deref())
            .find(|s| !s.is_empty())
            .map(str::to_owned);
        let mut steps = IndexMap::<String, Vec<usize>>::new();
        for (i, e) in entries.iter().enumerate() {
            if let Some(step) = e.step_id.as_deref().filter(|s| !s.is_empty()) {
                steps.entry(step.into()).or_default().push(i);
            }
        }
        if !sid.is_empty() {
            let s = self.sessions.entry(sid).or_default();
            for indexes in steps.values() {
                let request = indexes
                    .iter()
                    .copied()
                    .find(|i| entries[*i].event_name == Some(AgentEventName::LlmRequest));
                let response = indexes
                    .iter()
                    .copied()
                    .find(|i| entries[*i].event_name == Some(AgentEventName::LlmResponse));
                if let (Some(request), Some(response)) = (request, response) {
                    let mut has_usage = false;
                    if let Some(pair) =
                        Self::take_pair(s, turn.as_deref(), &entries[request], &entries[response])
                    {
                        entries[request].time_unix_nano = pair.start.to_string();
                        entries[response].time_unix_nano = pair.end.to_string();
                        if let Some(n) = pair.iteration_start {
                            entries[request].extra.insert(
                                "agent.qoderwork.step.start_time_unix_nano".into(),
                                n.to_string().into(),
                            );
                        }
                        if let Some(n) = pair.iteration_end {
                            entries[request].extra.insert(
                                "agent.qoderwork.step.end_time_unix_nano".into(),
                                n.to_string().into(),
                            );
                        }
                        if !pair.model.is_empty() {
                            for i in indexes {
                                if entries[*i]
                                    .request_model
                                    .as_deref()
                                    .is_none_or(|m| m.is_empty() || m == "auto")
                                {
                                    entries[*i].request_model = Some(pair.model.clone());
                                }
                                if entries[*i].event_name == Some(AgentEventName::LlmResponse) {
                                    entries[*i].response_model = Some(pair.model.clone());
                                }
                            }
                        }
                        has_usage = pair.usage.apply(&mut entries[response]);
                    }
                    if !has_usage {
                        if let Some(request_time) = stamp(&entries[request]) {
                            let request_ms = request_time / 1_000_000;
                            let best = s
                                .sdk_pairs
                                .iter()
                                .enumerate()
                                .filter_map(|(i, (start, _, _))| {
                                    let delta = (*start as i128 - request_ms).abs();
                                    (delta <= 5000).then_some((i, delta))
                                })
                                .min_by_key(|(_, delta)| *delta)
                                .map(|(i, _)| i);
                            if let Some(i) = best {
                                s.sdk_pairs.remove(i).1.apply(&mut entries[response]);
                            }
                        }
                    }
                }
                let model_response = indexes.iter().find_map(|i| {
                    (entries[*i].event_name == Some(AgentEventName::LlmResponse))
                        .then(|| stamp(&entries[*i]))
                        .flatten()
                });
                let mut used = Vec::new();
                for i in indexes {
                    let e = &mut entries[*i];
                    let Some(id) = e.tool_call_id.as_deref() else {
                        continue;
                    };
                    let timing = s.tools.get(id);
                    let nano = match e.event_name {
                        Some(AgentEventName::ToolCall) => {
                            preferred(timing.map(|t| t.pre.as_slice()).unwrap_or(&[]))
                                .or(model_response)
                                .or(timing.and_then(|t| t.requested))
                        }
                        Some(AgentEventName::ToolResult) => {
                            preferred(timing.map(|t| t.post.as_slice()).unwrap_or(&[]))
                                .or(timing.and_then(|t| t.finished))
                        }
                        _ => None,
                    };
                    if let Some(n) = nano {
                        e.time_unix_nano = n.to_string();
                        used.push(id.to_owned());
                    }
                }
                for id in used {
                    let has_call = indexes.iter().any(|i| {
                        entries[*i].event_name == Some(AgentEventName::ToolCall)
                            && entries[*i].tool_call_id.as_deref() == Some(id.as_str())
                    });
                    let has_result = indexes.iter().any(|i| {
                        entries[*i].event_name == Some(AgentEventName::ToolResult)
                            && entries[*i].tool_call_id.as_deref() == Some(id.as_str())
                    });
                    if let Some(t) = s.tools.get(&id) {
                        let start = preferred(&t.pre).or(t.requested).or(model_response);
                        let end = preferred(&t.post).or(t.finished);
                        if has_call && has_result && start.is_some() && end.is_some() {
                            s.tools.remove(&id);
                        }
                    }
                }
            }
        }
        let groups = steps.values().collect::<Vec<_>>();
        for adjacent in groups.windows(2) {
            let next = adjacent[1].iter().find_map(|i| {
                if entries[*i].event_name == Some(AgentEventName::LlmRequest) {
                    entries[*i]
                        .extra
                        .get("agent.qoderwork.step.start_time_unix_nano")
                        .and_then(Value::as_str)
                        .and_then(|n| n.parse::<i128>().ok())
                        .or_else(|| stamp(&entries[*i]))
                } else {
                    None
                }
            });
            if let Some(next) = next {
                for i in adjacent[0] {
                    if entries[*i].event_name == Some(AgentEventName::ToolResult)
                        && stamp(&entries[*i]).is_some_and(|n| n > next)
                    {
                        entries[*i].time_unix_nano = (next - 1_000_000).to_string();
                    }
                }
            }
        }
    }
    pub(super) fn evict(&mut self) {
        let cutoff = now_ms() - TTL;
        self.sessions.retain(|_, s| {
            s.pairs.retain(|p| p.seen >= cutoff);
            s.iterations.retain(|_, i| i.seen >= cutoff);
            s.flights.retain(|_, f| f.seen >= cutoff);
            s.tools.retain(|_, t| t.seen >= cutoff);
            s.subagents.retain(|_, seen| *seen >= cutoff);
            s.sdk_pairs.retain(|(_, _, seen)| *seen >= cutoff);
            if s.sdk_start.is_some_and(|(_, seen)| seen < cutoff) {
                s.sdk_start = None;
            }
            if s.directory.as_ref().is_some_and(|(_, seen)| *seen < cutoff) {
                s.directory = None;
            }
            !(s.pairs.is_empty()
                && s.iterations.is_empty()
                && s.flights.is_empty()
                && s.tools.is_empty()
                && s.subagents.is_empty()
                && s.sdk_pairs.is_empty()
                && s.sdk_start.is_none()
                && s.directory.is_none())
        });
    }
}

/// Bounded reads and identity come from the same opened handle on every platform.
/// A partial final line remains uncommitted for the next poll.
pub(super) async fn read_hook_lines(
    rt: &InputRuntime,
    path: &Path,
    name: &str,
) -> anyhow::Result<Vec<String>> {
    read_named_lines(rt, &rt.id, path, Some(name)).await
}
async fn read_lines(rt: &InputRuntime, key: &str, path: &Path) -> anyhow::Result<Vec<String>> {
    read_named_lines(rt, key, path, None).await
}
async fn read_named_lines(
    rt: &InputRuntime,
    key: &str,
    path: &Path,
    name: Option<&str>,
) -> anyhow::Result<Vec<String>> {
    let previous = rt.state_store.get(key);
    let same = name.is_none_or(|name| previous.last_file() == Some(name));
    let offset = if same {
        previous.last_offset().unwrap_or(0.0).max(0.0) as u64
    } else {
        0
    };
    let old = if same {
        previous.extra().and_then(|e| {
            e.get("fileIdentity")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
    } else {
        None
    };
    let old_inode = if same {
        previous
            .extra()
            .and_then(|e| e.get("inode").and_then(Value::as_u64))
    } else {
        None
    };
    // A startup size-only baseline must not open or load a large historical file.
    if old.is_none() {
        match tokio::fs::metadata(path).await {
            Ok(meta) if meta.len() <= offset => return Ok(Vec::new()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
            _ => {}
        }
    }
    let path = path.to_owned();
    let Some((identity, ino, next, bytes)) =
        tokio::task::spawn_blocking(move || -> std::io::Result<_> {
            let mut file = match std::fs::File::open(&path) {
                Ok(f) => f,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(e) => return Err(e),
            };
            let id = crate::utils::file_identity::identity_from_open(&file)?;
            let identity = format!("{}:{}:{}", id.dev, id.ino, id.birthtime_ms);
            let changed = old.as_ref().is_some_and(|old| old != &identity)
                || (old.is_none() && old_inode.is_some_and(|ino| ino != id.ino));
            let offset = if changed || offset > id.size {
                0
            } else {
                offset
            };
            file.seek(SeekFrom::Start(offset))?;
            let mut bytes = Vec::new();
            (&mut file)
                .take(id.size.saturating_sub(offset).min(MAX_READ))
                .read_to_end(&mut bytes)?;
            let committed = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |n| n + 1);
            bytes.truncate(committed);
            Ok(Some((identity, id.ino, offset + committed as u64, bytes)))
        })
        .await??
    else {
        return Ok(Vec::new());
    };
    let mut extra = previous
        .extra()
        .and_then(|e| e.as_object().cloned())
        .unwrap_or_default();
    extra.insert("inode".into(), json!(ino));
    extra.insert("fileIdentity".into(), identity.into());
    rt.state_store.set_offset(key, next as f64);
    rt.state_store.update(
        key,
        crate::checkpoints::InputStatePatch {
            last_file: name.map(str::to_owned),
            extra: Some(Value::Object(extra)),
            ..Default::default()
        },
    );
    Ok(String::from_utf8_lossy(&bytes)
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(str::to_owned)
        .collect())
}

#[cfg(test)]
impl WorkState {
    pub(super) fn fixture_cache_counts(&self) -> [usize; 4] {
        [
            self.sessions
                .values()
                .filter(|s| !s.pairs.is_empty())
                .count(),
            self.sessions
                .values()
                .filter(|s| !s.tools.is_empty())
                .count(),
            self.sessions
                .values()
                .filter(|s| !s.subagents.is_empty())
                .count(),
            self.sessions
                .values()
                .filter(|s| !s.flights.is_empty())
                .count(),
        ]
    }
    pub(super) fn fixture_backdate_cache(&mut self) {
        let old = now_ms() - TTL - 1;
        for s in self.sessions.values_mut() {
            for p in &mut s.pairs {
                p.seen = old;
            }
            for p in s.iterations.values_mut() {
                p.seen = old;
            }
            for p in s.flights.values_mut() {
                p.seen = old;
            }
            for p in s.tools.values_mut() {
                p.seen = old;
            }
            for seen in s.subagents.values_mut() {
                *seen = old;
            }
            for (_, _, seen) in &mut s.sdk_pairs {
                *seen = old;
            }
            if let Some((_, seen)) = &mut s.sdk_start {
                *seen = old;
            }
            if let Some((_, seen)) = &mut s.directory {
                *seen = old;
            }
        }
    }
}
