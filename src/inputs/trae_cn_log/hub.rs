use super::native::{hex, Evidence, NativeIndex, Todo};
use crate::hook_process::trae_cn::id_digest;
use crate::types::{AgentActivityEntry, AgentEventName};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const WINDOW: u64 = 4 * 1024 * 1024;
const MAX_FILES: usize = 64;
const MAX_REPORTS: usize = 512;

#[derive(Default)]
pub(super) struct Hub {
    files: HashMap<PathBuf, Cursor>,
    completed: BTreeMap<String, Turn>,
}

struct Cursor {
    file: File,
    offset: u64,
    skipping: bool,
    turn: Option<Turn>,
}

struct Turn {
    session: String,
    trace: String,
    last_seq: Option<u64>,
    contiguous: bool,
    done: bool,
    tools: HashSet<String>,
    reports: BTreeMap<u64, Usage>,
    plans: HashMap<String, Plan>,
    todos: HashMap<String, Option<TodoBody>>,
    timings: HashMap<String, Option<(u64, u64)>>,
    touched: Instant,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Usage {
    input: u64,
    output: u64,
    cached: Option<u64>,
    reasoning: Option<u64>,
    cache_created: Option<u64>,
}

struct Plan {
    seq: u64,
    content: String,
    call: Option<String>,
}

struct TodoBody {
    plan: String,
    status: Option<&'static str>,
    content: Option<(Value, Value)>,
}

impl Hub {
    pub fn refresh(&mut self, root: &Path, capture: bool) {
        if !capture {
            self.completed.values_mut().for_each(Turn::remove_content);
            for cursor in self.files.values_mut() {
                if let Some(turn) = cursor.turn.as_mut() {
                    turn.remove_content();
                }
            }
        }
        let mut seen = HashSet::new();
        for folder in fs::read_dir(root).into_iter().flatten().flatten() {
            if !folder.file_type().is_ok_and(|kind| kind.is_dir()) {
                continue;
            }
            for entry in fs::read_dir(folder.path()).into_iter().flatten().flatten() {
                let path = entry.path();
                if !path
                    .file_stem()
                    .and_then(|id| id.to_str())
                    .is_some_and(|id| hex(id, 24))
                    || path.extension().and_then(|ext| ext.to_str()) != Some("jsonl")
                    || !entry.file_type().is_ok_and(|kind| kind.is_file())
                {
                    continue;
                }
                if self.files.contains_key(&path) {
                    seen.insert(path);
                    continue;
                }
                if self.files.len() >= MAX_FILES {
                    continue;
                }
                if let Ok(file) = crate::utils::source_access::open_under(&path, root) {
                    seen.insert(path.clone());
                    self.files.insert(
                        path,
                        Cursor {
                            file,
                            offset: 0,
                            skipping: false,
                            turn: None,
                        },
                    );
                }
            }
        }
        let mut closed = Vec::new();
        for (path, cursor) in &mut self.files {
            let Some(reply) = path.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            let size = cursor
                .file
                .metadata()
                .ok()
                .map(|meta| meta.len())
                .unwrap_or(cursor.offset);
            let cap = if seen.contains(path) {
                WINDOW
            } else {
                WINDOW * 2
            };
            let total = size.saturating_sub(cursor.offset).min(cap);
            if cursor.drain(reply, total, capture).is_err() {
                if let Some(turn) = cursor.turn.as_mut() {
                    turn.contiguous = false;
                }
            }
            if !seen.contains(path) {
                if let Some(mut turn) = cursor.turn.take() {
                    if cursor.offset != size {
                        turn.contiguous = false;
                    }
                    self.completed.insert(reply.into(), turn);
                }
                closed.push(path.clone());
            }
        }
        for path in closed {
            self.files.remove(&path);
        }
        self.completed
            .retain(|_, turn| turn.touched.elapsed() < Duration::from_secs(3600));
        while self.completed.len() > MAX_FILES {
            if let Some(key) = self
                .completed
                .iter()
                .min_by_key(|(_, turn)| turn.touched)
                .map(|(key, _)| key.clone())
            {
                self.completed.remove(&key);
            }
        }
    }

    pub fn enrich(
        &self,
        row: &mut AgentActivityEntry,
        native: &NativeIndex,
        capture: bool,
    ) -> Vec<AgentActivityEntry> {
        if row.event_name != Some(AgentEventName::LlmResponse) {
            return Vec::new();
        }
        let mut ids = HashSet::new();
        let raw_ids = row.extra.shift_remove("agent.trae-cn.tool_call_ids");
        let mut remember = |id: &Value| {
            if let Some(id) = id.as_str().filter(|id| !id.is_empty() && id.len() <= 256) {
                ids.insert(id.to_owned());
            }
        };
        for id in raw_ids
            .as_ref()
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            remember(id);
        }
        for message in row
            .output_messages
            .as_ref()
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            for part in message["parts"].as_array().into_iter().flatten() {
                if part["type"] == "tool_call" {
                    remember(&part["id"]);
                }
            }
        }
        let evidence = native.evidence(&row.session_id, &ids);
        let matches = |reply: &str, turn: &Turn| {
            turn.session == row.session_id
                && (!ids.is_disjoint(&turn.tools)
                    || evidence.as_ref().is_some_and(|source| {
                        source.matches_owner(&turn.trace, reply) && source.owns_tools(reply, &ids)
                    }))
        };
        let mut candidates = self
            .files
            .iter()
            .filter_map(|(path, c)| {
                let reply = path.file_stem()?.to_str()?;
                let turn = c.turn.as_ref()?;
                matches(reply, turn).then_some((reply, turn))
            })
            .chain(
                self.completed
                    .iter()
                    .filter_map(|(reply, t)| matches(reply, t).then_some((reply.as_str(), t))),
            );
        let hub_turn = candidates
            .next()
            .filter(|_| candidates.next().is_none())
            .filter(|(reply, turn)| {
                evidence
                    .as_ref()
                    .is_none_or(|source| source.matches_owner(&turn.trace, reply))
            });
        let mut recovered = Vec::new();
        let mut recovered_parts = Vec::new();
        if let Some(source) = &evidence {
            let mut rounds = Vec::new();
            for round in source.rounds(&ids) {
                for todo in &round.todos {
                    if !ids.insert(todo.call.clone()) {
                        continue;
                    }
                    let receipt =
                        hub_turn.and_then(|(_, turn)| turn.todos.get(&todo.call)?.as_ref());
                    if let Some((rows, part)) = todo_rows(row, todo, receipt, capture) {
                        recovered.extend(rows);
                        if capture {
                            recovered_parts.push(part);
                        }
                    }
                }
                let mut record = serde_json::to_value(&round).unwrap_or(Value::Null);
                if let Some((reply, turn)) = hub_turn {
                    if let Some((start, first)) = round
                        .request
                        .as_ref()
                        .filter(|_| round.initial)
                        .and_then(|request| turn.timings.get(request).copied().flatten())
                    {
                        record["requestStartMs"] = json!(start);
                        record["firstTokenMs"] = json!(first);
                    }
                    let reports: Vec<_> = round
                        .reports
                        .iter()
                        .filter(|(id, _)| id == reply)
                        .filter_map(|(_, seq)| turn.reports.get(seq))
                        .collect();
                    if round.shared {
                        record["streamReceived"] = json!(reports.len());
                        record["streamExpected"] = json!(round.reports.len());
                        if let Some(tokens) = reports.iter().try_fold(0_u64, |sum, r| {
                            sum.checked_add(r.input)?.checked_add(r.output)
                        }) {
                            record["streamTokens"] = json!(tokens);
                        }
                    } else if let [report] = reports.as_slice() {
                        record["input"] = json!(report.input);
                        record["output"] = json!(report.output);
                        for (name, value) in [
                            ("cached", report.cached),
                            ("reasoning", report.reasoning),
                            ("cacheCreated", report.cache_created),
                        ] {
                            if let Some(value) = value {
                                record[name] = json!(value);
                            }
                        }
                    }
                }
                rounds.push(record);
            }
            if !rounds.is_empty() {
                row.extra
                    .insert("loongsuite.trae_cn.model_responses".into(), json!(rounds));
            }
        }
        if capture {
            if let Some(messages) = row.output_messages.as_mut().and_then(Value::as_array_mut) {
                if !recovered_parts.is_empty() {
                    let final_text = messages
                        .iter()
                        .position(|message| {
                            message["role"] == "assistant"
                                && message["parts"]
                                    .as_array()
                                    .is_some_and(|parts| parts.iter().any(|p| p["type"] == "text"))
                        })
                        .unwrap_or(messages.len());
                    messages.insert(
                        final_text,
                        json!({"role":"assistant","parts":recovered_parts}),
                    );
                }
                if let Some((_, turn)) = hub_turn {
                    let mut plans: Vec<_> = turn.plans.iter().collect();
                    plans.sort_by_key(|(_, p)| p.seq);
                    let parts: Vec<_> = plans.into_iter().filter(|(_, p)| !p.content.is_empty()).map(|(id, plan)| {
                        let mut part = json!({"type":"reasoning","content":plan.content,"plan_item_id":id});
                        if let Some(call) = plan.call.as_ref().filter(|id| ids.contains(*id)) {
                            part["tool_call_id"] = json!(call);
                        }
                        part
                    }).collect();
                    if !parts.is_empty() {
                        messages.insert(0, json!({"role":"assistant","parts":parts}));
                    }
                }
            }
        }
        if let Some((reply, turn)) = hub_turn {
            turn.apply_usage(row, reply, evidence.as_ref());
        }
        recovered
    }
}

impl Cursor {
    fn drain(&mut self, reply: &str, mut remaining: u64, capture: bool) -> std::io::Result<()> {
        while remaining > 0 {
            self.file.seek(SeekFrom::Start(self.offset))?;
            let mut bytes = Vec::with_capacity(remaining.min(WINDOW) as usize);
            (&mut self.file)
                .take(remaining.min(WINDOW))
                .read_to_end(&mut bytes)?;
            let Some(end) = bytes.iter().rposition(|&b| b == b'\n').map(|n| n + 1) else {
                if bytes.len() as u64 == WINDOW {
                    self.offset += WINDOW;
                    remaining -= WINDOW;
                    self.skipping = true;
                    if let Some(turn) = self.turn.as_mut() {
                        turn.contiguous = false;
                    }
                    continue;
                }
                break;
            };
            let start = if self.skipping {
                bytes.iter().position(|&b| b == b'\n').unwrap() + 1
            } else {
                0
            };
            self.skipping = false;
            self.offset += end as u64;
            remaining -= end as u64;
            for line in bytes[start..end]
                .split(|&b| b == b'\n')
                .filter(|line| !line.is_empty())
            {
                self.line(line, reply, capture);
            }
        }
        Ok(())
    }

    fn line(&mut self, line: &[u8], reply: &str, capture: bool) {
        let record = serde_json::from_slice::<Value>(line).ok();
        let Some((kind, record)) = record
            .as_ref()
            .and_then(|v| v["type"].as_str().map(|kind| (kind, v)))
        else {
            if let Some(turn) = self.turn.as_mut() {
                turn.contiguous = false;
            }
            return;
        };
        let seq = record["seq"].as_u64();
        let data = || {
            record["data"]
                .as_str()
                .and_then(|value| serde_json::from_str::<Value>(value).ok())
        };
        if self.turn.is_none() {
            if kind != "metadata" {
                return;
            }
            let Some(metadata) = data().filter(|v| v["reply_to_message_id"] == reply) else {
                return;
            };
            let Some(session) = metadata["session_id"].as_str().filter(|id| hex(id, 24)) else {
                return;
            };
            let Some(trace) = metadata["trace_id"].as_str().filter(|id| hex(id, 32)) else {
                return;
            };
            self.turn = Some(Turn {
                session: session.into(),
                trace: trace.into(),
                last_seq: seq,
                contiguous: matches!(seq, Some(0 | 1)),
                done: false,
                tools: HashSet::new(),
                reports: BTreeMap::new(),
                plans: HashMap::new(),
                todos: HashMap::new(),
                timings: HashMap::new(),
                touched: Instant::now(),
            });
            return;
        }
        let Some(turn) = self.turn.as_mut() else {
            return;
        };
        turn.touched = Instant::now();
        turn.contiguous &= seq.is_some() && seq == turn.last_seq.and_then(|seq| seq.checked_add(1));
        turn.last_seq = seq;
        if !matches!(kind, "done" | "plan_item" | "token_usage" | "timing_events") {
            return;
        }
        let Some(data) = data().filter(|v| v["reply_to_message_id"] == reply) else {
            turn.contiguous = false;
            return;
        };
        match kind {
            "done" => turn.done = true,
            "plan_item" => {
                if let Some(seq) = seq {
                    turn.plan(&data, seq, capture);
                }
            }
            "token_usage" => {
                if let Some((seq, usage)) = seq.zip(Usage::from(&data)) {
                    if let Some(previous) = turn.reports.get(&seq) {
                        turn.contiguous &= *previous == usage;
                    } else if turn.reports.len() < MAX_REPORTS {
                        turn.reports.insert(seq, usage);
                    } else {
                        turn.contiguous = false;
                    }
                } else {
                    turn.contiguous = false;
                }
            }
            "timing_events" => {
                let timing = data["data"]["rs_17_before_request_llm"]
                    .as_u64()
                    .zip(data["data"]["rs_18_llm_response_first_token"].as_u64())
                    .filter(|(start, first)| *start > 0 && first >= start);
                if let Some((id, timing)) = data["logid"]
                    .as_str()
                    .filter(|id| !id.is_empty() && id.len() <= 128)
                    .zip(timing)
                {
                    if let Some(value) = turn.timings.get_mut(id) {
                        if *value != Some(timing) {
                            *value = None;
                        }
                    } else if turn.timings.len() < MAX_REPORTS {
                        turn.timings.insert(id.into(), Some(timing));
                    }
                }
            }
            _ => {}
        }
    }
}

impl Usage {
    fn from(row: &Value) -> Option<Self> {
        let input = row["prompt_tokens"].as_u64()?;
        let output = row["completion_tokens"].as_u64()?;
        if input.checked_add(output)? != row["total_tokens"].as_u64()? {
            return None;
        }
        Some(Self {
            input,
            output,
            cached: row["cache_read_input_tokens"]
                .as_u64()
                .or_else(|| row["prompt_tokens_details"]["cached_tokens"].as_u64())
                .filter(|n| *n <= input),
            reasoning: row["reasoning_tokens"].as_u64().filter(|n| *n <= output),
            cache_created: row["cache_creation_input_tokens"]
                .as_u64()
                .filter(|n| *n <= input),
        })
    }
}

impl Turn {
    fn remove_content(&mut self) {
        self.plans.clear();
        for todo in self.todos.values_mut().flatten() {
            todo.content = None;
        }
    }

    fn plan(&mut self, data: &Value, seq: u64, capture: bool) {
        let info = &data["tool_call_info"];
        let call = info["meta"]["llm_toolcall_id"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 256);
        if let Some(call) = call.filter(|_| self.tools.len() < 512) {
            self.tools.insert(call.into());
        }
        let Some(id) = data["id"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 128)
        else {
            return;
        };
        if capture && (self.plans.contains_key(id) || self.plans.len() < 24) {
            let previous = self.plans.get(id);
            if previous.is_none_or(|prior| seq > prior.seq) {
                let content = data["reasoning_content"]
                    .as_str()
                    .map(truncate)
                    .or_else(|| previous.map(|plan| plan.content.clone()));
                if let Some(content) = content {
                    let call = call
                        .map(str::to_owned)
                        .or_else(|| previous.and_then(|plan| plan.call.clone()));
                    self.plans.insert(id.into(), Plan { seq, content, call });
                }
            }
        }
        if let Some(call) =
            call.filter(|_| info["name"] == "TodoWrite" && info["result"]["status"].is_string())
        {
            let status = match info["result"]["status"].as_str() {
                Some("success") => Some("success"),
                Some("error" | "failure") => Some("failure"),
                _ => None,
            };
            let content = if capture && !info["params"].is_null() {
                let result = info["result"].get("data").unwrap_or(&info["result"]);
                (info["params"].to_string().len() + result.to_string().len() <= 16_000)
                    .then(|| (info["params"].clone(), result.clone()))
            } else {
                None
            };
            if let Some(prior) = self.todos.get_mut(call) {
                if let Some(old) = prior {
                    let differs = old.plan != id
                        || old.status.zip(status).is_some_and(|(a, b)| a != b)
                        || old
                            .content
                            .as_ref()
                            .zip(content.as_ref())
                            .is_some_and(|(a, b)| a.0 != b.0);
                    if differs {
                        *prior = None;
                    } else {
                        old.status = old.status.or(status);
                        if old.content.is_none() {
                            old.content = content;
                        }
                    }
                }
            } else if self.todos.len() < 24 {
                self.todos.insert(
                    call.into(),
                    Some(TodoBody {
                        plan: id.into(),
                        status,
                        content,
                    }),
                );
            }
        }
    }

    fn apply_usage(&self, row: &mut AgentActivityEntry, reply: &str, source: Option<&Evidence>) {
        let expected = source.and_then(|source| source.expected(reply));
        let complete = if expected.is_some() {
            source.is_some_and(|source| {
                source.complete(reply, self.reports.keys().copied(), self.reports.len())
            })
        } else {
            self.contiguous && self.done
        };
        let extra = &mut row.extra;
        for (key, value) in [
            ("trace_id", json!(self.trace)),
            (
                "usage_event_seqs",
                json!(self
                    .reports
                    .keys()
                    .map(|seq| seq.to_string())
                    .collect::<Vec<_>>()
                    .join(",")),
            ),
            ("usage_received", json!(self.reports.len())),
            ("complete", json!(complete)),
        ] {
            extra.insert(format!("agent.trae-cn.hub.{key}"), value);
        }
        if let Some(expected) = expected {
            extra.insert(
                "agent.trae-cn.hub.usage_expected".into(),
                json!(expected.len()),
            );
            let missing = expected
                .iter()
                .filter(|seq| !self.reports.contains_key(seq))
                .map(|seq| seq.to_string())
                .collect::<Vec<_>>()
                .join(",");
            extra.insert(
                "agent.trae-cn.hub.missing_usage_seqs".into(),
                json!(missing),
            );
        }
        if self.reports.is_empty() {
            return;
        }
        let sum = |get: fn(&Usage) -> Option<u64>| {
            self.reports
                .values()
                .try_fold(0_u64, |acc, value| acc.checked_add(get(value)?))
        };
        let Some((input, output)) = sum(|u| Some(u.input)).zip(sum(|u| Some(u.output))) else {
            return;
        };
        let Some(total) = input.checked_add(output) else {
            return;
        };
        let cached = sum(|u| u.cached);
        for (key, value) in [
            ("input_tokens_observed", Some(input)),
            ("output_tokens_observed", Some(output)),
            ("total_tokens_observed", Some(total)),
            ("cached_tokens_observed", cached),
        ] {
            if let Some(value) = value {
                extra.insert(format!("agent.trae-cn.hub.{key}"), json!(value));
            }
        }
        if let Some(cached) = cached.filter(|_| input > 0) {
            extra.insert(
                "agent.trae-cn.hub.cache_hit_ratio_observed".into(),
                json!(cached as f64 / input as f64),
            );
        }
        if !complete {
            return;
        }
        let counts = [
            (&mut row.input_tokens, Some(input)),
            (&mut row.output_tokens, Some(output)),
            (&mut row.total_tokens, Some(total)),
            (&mut row.cache_read_input_tokens, cached),
            (
                &mut row.cache_creation_input_tokens,
                sum(|u| u.cache_created),
            ),
        ];
        let reasoning = sum(|u| u.reasoning);
        let reasoning_key = "gen_ai.usage.reasoning_tokens";
        if counts.iter().any(|(old, candidate)| {
            candidate.is_some_and(|new| {
                i64::try_from(new).map_or(true, |new| old.is_some_and(|old| old != new))
            })
        }) || reasoning
            .zip(row.extra.get(reasoning_key).and_then(Value::as_u64))
            .is_some_and(|(new, old)| new != old)
        {
            return;
        }
        for (old, candidate) in counts {
            if let Some(value) = candidate.and_then(|value| i64::try_from(value).ok()) {
                *old = Some(value);
            }
        }
        if let Some(reasoning) = reasoning {
            row.extra.entry(reasoning_key).or_insert(json!(reasoning));
        }
    }
}

fn truncate(text: &str) -> String {
    let mut end = text.len().min(8192);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

fn todo_rows(
    row: &AgentActivityEntry,
    todo: &Todo,
    receipt: Option<&TodoBody>,
    capture: bool,
) -> Option<([AgentActivityEntry; 2], Value)> {
    let trace = row.trace_id.as_deref()?;
    let span = id_digest(trace, "TodoWrite", &todo.call, 16);
    let mut part = json!({"type":"tool_call","name":"TodoWrite","id":todo.call});
    let mut base = json!({
        "trace_id":trace,"span_id":span,"parent_span_id":row.parent_span_id,
        "gen_ai.turn.id":row.turn_id,"gen_ai.step.id":row.step_id,
        "gen_ai.session.id":row.session_id,"gen_ai.provider.name":row.provider_name,
        "gen_ai.agent.type":row.agent_type,"gen_ai.agent.name":row.agent_name,
        "gen_ai.agent.id":row.agent_id,"user.id":row.user_id,
        "gen_ai.span.kind":"TOOL","gen_ai.operation.name":"execute_tool",
        "gen_ai.tool.name":"TodoWrite","gen_ai.tool.call.id":todo.call,
        "agent.trae-cn.tool_timing_source":"native_start_to_batch_commit",
    });
    let mut call = base.clone();
    call["event.name"] = json!("tool.call");
    call["event.id"] = json!(id_digest(trace, "todo-call", &todo.call, 32));
    call["time_unix_nano"] = json!(todo.start.to_string());
    base["event.name"] = json!("tool.result");
    base["event.id"] = json!(id_digest(trace, "todo-result", &todo.call, 32));
    base["time_unix_nano"] = json!(todo.committed_at.to_string());
    if let Some(status) = receipt.and_then(|receipt| receipt.status) {
        base["tool.result.status"] = json!(status);
        if status == "failure" {
            base["error.type"] = json!("tool_use_failure");
        }
    }
    if let Some((arguments, result)) = receipt.and_then(|r| r.content.as_ref()).filter(|_| capture)
    {
        call["gen_ai.tool.call.arguments"] = arguments.clone();
        part["arguments"] = arguments.clone();
        base["gen_ai.tool.call.result"] = result.clone();
    }
    Some((
        [
            serde_json::from_value(call).ok()?,
            serde_json::from_value(base).ok()?,
        ],
        part,
    ))
}
