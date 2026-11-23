//! Native IDE requests are identified by SQLite, and tool bodies are read
//! from authorized transcript ranges. Checkpoints retain metadata only.

use super::ide_delegation_sqlite::{self, valid_id, NativeRequest};
use super::subagents::{blocks, digest, text};
use super::transcript_scanner::{
    self as scanner, FileVersion, PendingLine, ScanBudget, ScanOptions,
};
use crate::hook_process::{build_collected_transcript_turn, CollectedTranscriptTurnContext};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

pub(super) const KEY: &str = "__qoderIdeDelegations";
const MAX_WORK: usize = 4096;
const MAX_AGE_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const MAX_WORK_BYTES: usize = 4 * 1024 * 1024;

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct Progress {
    offset: u64,
    version: Option<FileVersion>,
    pending: Option<PendingLine>,
    // One matching native row per call/result. Re-read bodies only when emitted.
    matches: HashMap<String, (u64, u64)>,
    ambiguous: bool,
}

#[derive(Serialize, Deserialize)]
struct Work {
    session: String,
    turn: String,
    call: String,
    trace: String,
    span: String,
    path: PathBuf,
    user: String,
    cwd: Option<String>,
    created: i64,
    #[serde(default)]
    tried: i64,
    #[serde(default)]
    attempts: usize,
    invoked: bool,
    delivered: bool,
    complete: bool,
    parent: Progress,
    child: Progress,
    #[serde(default)]
    child_identity: Option<(String, String)>,
}

#[derive(Default)]
pub(super) struct Delegations {
    entries: IndexMap<String, Work>,
}

impl Delegations {
    pub(super) fn load(value: Option<&Value>, now: i64) -> Self {
        let mut entries: IndexMap<String, Work> = value
            .and_then(|value| serde_json::from_value(value.clone()).ok())
            .unwrap_or_default();
        entries.retain(|id, work| {
            now.saturating_sub(work.created) < MAX_AGE_MS
                && *id == work_key(&work.session, &work.turn, &work.call)
                && valid_id(&work.session)
                && valid_id(&work.call)
                && work.trace.len() == 32
                && work.trace.bytes().all(|byte| byte.is_ascii_hexdigit())
                && work.span.len() == 16
                && work.span.bytes().all(|byte| byte.is_ascii_hexdigit())
                && work.path.is_absolute()
                && ide_path(&work.path, &work.session)
        });
        entries.truncate(MAX_WORK);
        Self { entries }
    }

    pub(super) fn has_pending(&self) -> bool {
        self.entries.values().any(|work| !work.complete)
    }

    pub(super) fn save(self, state: &mut Value) -> anyhow::Result<()> {
        if !self.entries.is_empty() || state.get(KEY).is_some() {
            state[KEY] = serde_json::to_value(self.entries)?;
        }
        Ok(())
    }

    pub(super) fn register(&mut self, records: &mut [Value], path: &Path, now: i64) {
        for record in records.iter_mut().filter(|row| {
            row["event.name"] == "tool.call"
                && row["gen_ai.agent.type"] == "qoder"
                && row["gen_ai.tool.name"] == "Agent"
        }) {
            let Some(session) = text(record, "gen_ai.session.id").filter(|v| valid_id(v)) else {
                continue;
            };
            let Some(call) = text(record, "gen_ai.tool.call.id").filter(|v| valid_id(v)) else {
                continue;
            };
            let Some(turn) = text(record, "gen_ai.turn.id") else {
                continue;
            };
            let Some(trace) = text(record, "trace_id").filter(|v| v.len() == 32) else {
                continue;
            };
            if !ide_path(path, session) {
                continue;
            }
            let id = work_key(session, turn, call);
            if self.entries.contains_key(&id) {
                continue;
            }
            if self.entries.len() >= MAX_WORK {
                let Some(finished) = self.entries.values().position(|work| work.complete) else {
                    continue;
                };
                self.entries.shift_remove_index(finished);
            }
            self.entries.insert(
                id,
                Work {
                    session: session.into(),
                    turn: turn.into(),
                    call: call.into(),
                    trace: trace.into(),
                    span: digest(&json!(["qoder-tool", session, turn, call]))[..16].into(),
                    path: path.into(),
                    user: record["user.id"].as_str().unwrap_or("").into(),
                    cwd: record["workspace.path"].as_str().map(str::to_owned),
                    created: now,
                    tried: 0,
                    attempts: 0,
                    invoked: false,
                    delivered: false,
                    complete: false,
                    parent: Progress::default(),
                    child: Progress::default(),
                    child_identity: None,
                },
            );
        }
        for record in records
            .iter_mut()
            .filter(|row| row["gen_ai.agent.type"] == "qoder")
        {
            if let Some(work) = find_work(record).and_then(|id| self.entries.get(&id)) {
                record["span_id"] = json!(work.span);
            }
        }
    }

    pub(super) async fn resolve(
        &mut self,
        records: &mut Vec<Value>,
        databases: Vec<String>,
        now: i64,
        budget: &mut ScanBudget,
        cancel: &AtomicBool,
    ) {
        if databases.is_empty() {
            return;
        }
        let mut pending = self
            .entries
            .iter()
            .filter(|(_, work)| !work.complete && now.saturating_sub(work.tried) >= 5000)
            .map(|(id, work)| (work.tried, id.clone()))
            .collect::<Vec<_>>();
        pending.sort_unstable();
        let mut emitted = Vec::new();
        let mut remaining = MAX_WORK_BYTES;
        for (_, id) in pending.into_iter().take(8) {
            if cancel.load(Ordering::Relaxed) || budget.remaining <= 0 || remaining == 0 {
                break;
            }
            let work = &mut self.entries[&id];
            work.tried = now;
            let first = work.attempts % databases.len();
            work.attempts = work.attempts.saturating_add(4);
            let Some(peer) = ide_delegation_sqlite::read_request(
                databases.clone(),
                work.session.clone(),
                work.call.clone(),
                first,
            )
            .await
            else {
                continue;
            };
            let start = emitted.len();
            if let Err(error) = resolve_work(&id, work, peer, budget, cancel, &mut emitted) {
                crate::utils::create_logger("QoderIdeDelegations").debug(
                    "Native IDE delegation is pending",
                    json!({"reason":error.to_string()}).as_object(),
                );
            }
            let bytes = emitted[start..]
                .iter()
                .filter_map(|row| crate::utils::json_size::serialized_json_size(row).ok())
                .fold(0_usize, |total, size| total.saturating_add(size));
            remaining = remaining.saturating_sub(bytes);
            if let Some((child, _)) = &work.child_identity {
                for record in records
                    .iter_mut()
                    .filter(|r| find_work(r).as_deref() == Some(&id))
                {
                    decorate_caller(record, work, &id, child, None);
                }
            }
        }
        for record in &mut emitted {
            if let Some(path) = record
                .as_object_mut()
                .and_then(|row| row.remove("__native_ide_path"))
            {
                if let Some(path) = path.as_str() {
                    self.register(std::slice::from_mut(record), Path::new(path), now);
                }
            }
        }
        records.extend(emitted);
    }
}

fn ide_path(path: &Path, session: &str) -> bool {
    path.parent()
        .and_then(Path::file_name)
        .is_some_and(|name| name == "transcript")
        && path
            .file_name()
            .is_some_and(|name| name == format!("{session}.jsonl").as_str())
}

fn work_key(session: &str, turn: &str, call: &str) -> String {
    digest(&json!(["qoder-ide-delegation", session, turn, call]))[..32].to_owned()
}

fn find_work(row: &Value) -> Option<String> {
    matches!(
        row["event.name"].as_str(),
        Some("tool.call" | "tool.result")
    )
    .then_some(())?;
    Some(work_key(
        text(row, "gen_ai.session.id")?,
        text(row, "gen_ai.turn.id")?,
        text(row, "gen_ai.tool.call.id")?,
    ))
}

type ToolRows = HashMap<String, Value>;

fn scan_tools(
    path: &Path,
    session: &str,
    ids: &HashSet<&str>,
    scan: &mut Progress,
    budget: &mut ScanBudget,
    cancel: &AtomicBool,
) -> anyhow::Result<ToolRows> {
    let (_, version) = scanner::open_versioned(path)?;
    if scan.version.as_ref().is_some_and(|prior| {
        prior.ino != version.ino
            || prior.dev != version.dev
            || prior.size > version.size
            || (prior.size == version.size && prior != &version)
    }) {
        *scan = Progress::default();
    }
    let options = ScanOptions::default();
    if scan.offset < version.size && !scan.ambiguous {
        let batch = scanner::scan_lines(
            path,
            scan.offset..version.size,
            &options,
            scan.pending.take(),
            budget,
            cancel,
            |line| {
                let Some(row) = line.row.as_ref().filter(|row| row["sessionId"] == session) else {
                    return true;
                };
                for (key, _) in matching_tools(row, ids) {
                    if scan.matches.insert(key, (line.start, line.end)).is_some() {
                        scan.ambiguous = true;
                        return false;
                    }
                }
                true
            },
        )?;
        anyhow::ensure!(
            batch.version == version,
            "IDE transcript changed during scan"
        );
        scan.offset = batch.next_offset;
        scan.pending = batch.pending;
    }
    scan.version = Some(version.clone());
    anyhow::ensure!(!scan.ambiguous, "ambiguous IDE tool transcript");
    let mut rows = HashMap::new();
    for (key, &(start, end)) in &scan.matches {
        let mut selected = None;
        let read = scanner::scan_lines(path, start..end, &options, None, budget, cancel, |line| {
            selected = line.row;
            false
        })?;
        anyhow::ensure!(
            read.version == version,
            "IDE transcript changed during lookup"
        );
        let Some(mut row) = selected else {
            return Ok(HashMap::new());
        };
        let Some(block) = matching_tools(&row, ids)
            .find_map(|(found, value)| (found == *key).then(|| value.clone()))
        else {
            anyhow::bail!("IDE transcript tool proof changed");
        };
        row["message"]["content"] = json!([block]);
        rows.insert(key.clone(), row);
    }
    Ok(rows)
}

fn matching_tools<'a>(
    row: &'a Value,
    ids: &'a HashSet<&str>,
) -> impl Iterator<Item = (String, &'a Value)> {
    blocks(row).filter_map(move |block| {
        let (phase, call) = match block["type"].as_str()? {
            "tool_use" => ("call", text(block, "id")?),
            "tool_result" => ("result", text(block, "tool_use_id")?),
            _ => return None,
        };
        ids.contains(call)
            .then(|| (format!("{phase}:{call}"), block))
    })
}

fn resolve_work(
    id: &str,
    work: &mut Work,
    peer: NativeRequest,
    budget: &mut ScanBudget,
    cancel: &AtomicBool,
    emitted: &mut Vec<Value>,
) -> anyhow::Result<()> {
    let identity = (peer.session.clone(), peer.request.clone());
    if work
        .child_identity
        .as_ref()
        .is_some_and(|previous| previous != &identity)
    {
        anyhow::bail!("IDE child request changed");
    }
    work.child_identity = Some(identity);
    let parent = scan_tools(
        &work.path,
        &work.session,
        &HashSet::from([work.call.as_str()]),
        &mut work.parent,
        budget,
        cancel,
    )?;
    let Some(call) = parent.get(&format!("call:{}", work.call)) else {
        return Ok(());
    };
    let Some(input) = call
        .pointer("/message/content/0")
        .filter(|block| block["name"] == "Agent")
        .map(|block| &block["input"])
    else {
        return Ok(());
    };
    let name = text(input, "subagent_type");
    let prompt = input["prompt"].as_str();
    if !work.invoked {
        let mut event = audit(id, work, &peer.session, name, "invoke", call);
        if let Some(prompt) = prompt {
            event["gen_ai.input.messages"] = messages("user", prompt);
        }
        emitted.push(event);
        work.invoked = true;
    }
    let Some(result) = parent.get(&format!("result:{}", work.call)) else {
        return Ok(());
    };
    let Some(block) = result.pointer("/message/content/0") else {
        return Ok(());
    };
    let failed = block["is_error"] == true;
    let delivered = block["content"]
        .as_str()
        .filter(|content| result["toolUseResult"].as_str() == Some(content));
    if input["run_in_background"] == true
        || input["async"] == true
        || (!failed && delivered.is_none())
    {
        return Ok(());
    }
    if !work.delivered {
        let mut event = audit(id, work, &peer.session, name, "result", result);
        event["tool.result.status"] = json!(if failed { "error" } else { "success" });
        if let Some(content) = block["content"].as_str() {
            event["gen_ai.output.messages"] = messages("assistant", content);
        }
        emitted.push(event);
        work.delivered = true;
    }
    let (Some(inventory), Some(prompt)) =
        (&peer.messages, prompt.filter(|prompt| !prompt.is_empty()))
    else {
        return Ok(());
    };
    let Some(first) = inventory.first().filter(|m| m.role == "user") else {
        return Ok(());
    };
    if inventory.iter().filter(|msg| msg.role == "user").count() != 1
        || inventory.last().is_none_or(|msg| msg.role != "assistant")
    {
        return Ok(());
    }
    let tool_ids = inventory
        .iter()
        .filter(|msg| msg.role == "tool")
        .map(|msg| msg.tool.as_deref().filter(|id| valid_id(id)))
        .collect::<Option<HashSet<_>>>();
    let Some(tool_ids) = tool_ids else {
        return Ok(());
    };
    let child_path = work.path.with_file_name(format!("{}.jsonl", peer.session));
    let child_tools = if tool_ids.is_empty() {
        HashMap::new()
    } else {
        let real = child_path.canonicalize()?;
        anyhow::ensure!(
            real.parent() == Some(work.path.parent().unwrap().canonicalize()?.as_path()),
            "IDE child escaped transcript directory"
        );
        scan_tools(
            &child_path,
            &peer.session,
            &tool_ids,
            &mut work.child,
            budget,
            cancel,
        )?
    };
    let mut rows = vec![
        json!({"type":"user","sessionId":peer.session,"uuid":first.id,"timestamp":iso(first.at),
        "message":{"role":"user","content":prompt}}),
    ];
    for group in inventory[1..].chunk_by(|_, right| right.role != "assistant") {
        let model = &group[0];
        let Some((input, output, cache)) = model.usage.filter(|_| model.role == "assistant") else {
            return Ok(());
        };
        let mut content = Vec::new();
        let mut results = Vec::new();
        for tool in group[1..].iter().filter(|msg| msg.role == "tool") {
            let call = tool.tool.as_deref().unwrap();
            let Some((call, result)) = child_tools
                .get(&format!("call:{call}"))
                .zip(child_tools.get(&format!("result:{call}")))
            else {
                return Ok(());
            };
            content.push(call["message"]["content"][0].clone());
            results.push(result.clone());
        }
        let mut message = json!({"id":model.id,"role":"assistant","content":content,
            "usage":{"input_tokens":input,"output_tokens":output,"cache_read_input_tokens":cache}});
        if let Some(model) = &model.model {
            message["model"] = json!(model);
        }
        if !content.is_empty() {
            message["stop_reason"] = json!("tool_use");
        }
        rows.push(json!({"type":"assistant","sessionId":peer.session,"uuid":model.id,"timestamp":iso(model.at),"message":message}));
        rows.extend(results);
    }
    let turn = digest(&json!(["qoder-ide-request", peer.session, peer.request]));
    let attributes = Map::new();
    let records = build_collected_transcript_turn(
        &rows,
        CollectedTranscriptTurnContext {
            agent_id: "qoder",
            session_id: &peer.session,
            turn_id: &turn,
            runtime_user: &work.user,
            cwd: work.cwd.as_deref(),
            user_name: None,
            user_email: None,
            agent_name: name,
            span_attributes: &attributes,
            resource_attributes: &attributes,
        },
    );
    let mut models = inventory.iter().filter(|msg| msg.role == "assistant");
    let mut child = Vec::with_capacity(records.len());
    let response_ids: HashSet<String> = records
        .iter()
        .filter_map(|record| text(record, "gen_ai.response.id").map(str::to_owned))
        .collect();
    for record in records {
        if record["event.name"] == "llm.request" {
            let Some(model) = models.next() else {
                return Ok(());
            };
            if !response_ids.contains(&model.id) {
                let Some((input, output, cache)) = model.usage else {
                    return Ok(());
                };
                let mut response = record.clone();
                response["event.name"] = json!("llm.response");
                response["gen_ai.response.id"] = json!(model.id);
                response["time_unix_nano"] = json!(nanos(model.at));
                response["gen_ai.usage.input_tokens"] = json!(input);
                response["gen_ai.usage.output_tokens"] = json!(output);
                response["gen_ai.usage.cache_read.input_tokens"] = json!(cache);
                response["agent.source"] = json!("qoder-ide-sqlite-metadata");
                response
                    .as_object_mut()
                    .unwrap()
                    .remove("gen_ai.input.messages_delta");
                if let Some(model) = &model.model {
                    response["gen_ai.response.model"] = json!(model);
                }
                if !failed && inventory.last().is_some_and(|last| last.id == model.id) {
                    if let Some(content) = delivered.filter(|body| !body.is_empty()) {
                        response["gen_ai.output.messages"] = messages("assistant", content);
                        response["agent.source"] = json!("qoder-ide-agent-result");
                    }
                }
                child.push(record);
                child.push(response);
                continue;
            }
        }
        child.push(record);
    }
    if models.next().is_some() || child.is_empty() {
        return Ok(());
    }
    let last = child.len() - 1;
    for (index, row) in child.iter_mut().enumerate() {
        row["event.id"] = json!(digest(&json!([
            turn,
            index,
            row["event.name"],
            row["gen_ai.tool.call.id"]
        ])));
        row["trace_id"] = json!(work.trace);
        row["parent_span_id"] = json!(work.span);
        row["agent.qoder.trace_context_locked"] = json!(true);
        row["gen_ai.agent.id"] = json!(peer.session);
        row["gen_ai.agent.scope"] = json!("subagent");
        row["gen_ai.agent.parent.id"] = json!(work.session);
        row["gen_ai.agent.parent.invocation.id"] = json!(id);
        row["gen_ai.subagent.parent_tool_call.id"] = json!(work.call);
        row["agent.qoder.parent_turn_id"] = json!(work.turn);
        row["agent.qoder.subagent_id"] = json!(peer.session);
        row["gen_ai.request.id"] = json!(peer.request);
        row["agent.request_id"] = json!(peer.request);
        row["__native_ide_path"] = json!(child_path);
        for (field, enabled) in [
            ("gen_ai.turn.start", index == 0),
            ("gen_ai.turn.end", index == last),
        ] {
            if enabled {
                row[field] = json!(true);
            } else {
                row.as_object_mut().unwrap().remove(field);
            }
        }
        for field in ["gen_ai.request.model", "gen_ai.response.model"] {
            if row[field] == "unknown" {
                row.as_object_mut().unwrap().remove(field);
            }
        }
    }
    emitted.extend(child);
    work.complete = true;
    work.parent = Progress::default();
    work.child = Progress::default();
    Ok(())
}

fn decorate_caller(row: &mut Value, work: &Work, id: &str, peer: &str, name: Option<&str>) {
    row["gen_ai.agent.id"] = json!(work.session);
    row["gen_ai.agent.invocation.id"] = json!(id);
    row["gen_ai.agent.peer.id"] = json!(peer);
    if let Some(name) = name {
        row["gen_ai.agent.peer.name"] = json!(name);
    }
}

fn audit(
    id: &str,
    work: &Work,
    peer: &str,
    name: Option<&str>,
    event: &str,
    source: &Value,
) -> Value {
    let at = source["timestamp"]
        .as_str()
        .and_then(|ts| chrono::DateTime::parse_from_rfc3339(ts).ok())
        .map_or(work.created, |ts| ts.timestamp_millis());
    let mut row = json!({
        "event.id":digest(&json!([id,event])), "event.name":format!("gen_ai.agent.{event}"),
        "time_unix_nano":nanos(at), "gen_ai.agent.type":"qoder",
        "gen_ai.session.id":work.session, "gen_ai.turn.id":work.turn, "gen_ai.tool.call.id":work.call,
        "gen_ai.tool.name":"Agent", "trace_id":work.trace, "parent_span_id":work.span,
        "agent.qoder.trace_context_locked":true, "user.id":work.user, "agent.source":"qoder-transcript-hook",
    });
    if let Some(cwd) = &work.cwd {
        row["workspace.path"] = json!(cwd);
    }
    decorate_caller(&mut row, work, id, peer, name);
    row
}

fn messages(role: &str, text: &str) -> Value {
    json!([{"role":role,"parts":[{"type":"text","content":text}]}])
}

fn iso(at: i64) -> String {
    chrono::DateTime::from_timestamp_millis(at)
        .map(|value| value.to_rfc3339())
        .unwrap_or_default()
}

fn nanos(at: i64) -> String {
    (i128::from(at) * 1_000_000).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn late_native_delegation_recovers_and_restarts_without_reemitting() {
        let root = tempfile::tempdir().unwrap();
        let transcript = root.path().join("transcript");
        std::fs::create_dir(&transcript).unwrap();
        let parent = transcript.join("parent.jsonl");
        let messages = [
            json!({"type":"assistant","sessionId":"parent","timestamp":"2026-11-20T10:00:01Z",
                "message":{"role":"assistant","content":[{"type":"tool_use","id":"tool-id","name":"Agent",
                    "input":{"prompt":"child question","subagent_type":"explore"}}]}}),
            json!({"type":"user","sessionId":"parent","timestamp":"2026-11-20T10:00:04Z","toolUseResult":"verified child answer",
                "message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-id","content":"verified child answer"}]}}),
        ];
        std::fs::write(
            &parent,
            messages
                .iter()
                .map(|row| format!("{row}\n"))
                .collect::<String>(),
        )
        .unwrap();
        let at = 1_795_168_801_000;
        let mut state = json!({});
        let mut work = Delegations::default();
        let mut output = vec![
            json!({"event.name":"tool.call","gen_ai.agent.type":"qoder","gen_ai.tool.name":"Agent",
            "gen_ai.session.id":"parent","gen_ai.tool.call.id":"tool-id","gen_ai.turn.id":"parent-turn",
            "trace_id":"7341af38123412341234123412341234","user.id":"fixture"}),
        ];
        work.register(&mut output, &parent, at);
        let span = output[0]["span_id"].clone();
        work.save(&mut state).unwrap();
        assert!(!state.to_string().contains("child question"));
        drop(output);
        let db_path = root.path().join("qoder.db");
        let db = rusqlite::Connection::open(&db_path).unwrap();
        db.execute_batch(
            r#"CREATE TABLE chat_record(session_id, request_id, parent_session_id, parent_tool_call_id, extra);
             CREATE TABLE chat_message(id, role, gmt_create, session_id, request_id, token_info, model_info, tool_result);
             INSERT INTO chat_record VALUES ('irrelevant','wrong','other','tool-id',NULL);
             INSERT INTO chat_record VALUES ('child','native-request','parent','tool-id',NULL);
             INSERT INTO chat_message VALUES ('user-native','user',1795168802000,'child','native-request',NULL,NULL,NULL);
             INSERT INTO chat_message VALUES ('assistant-native','assistant',1795168803000,'child','native-request',
                '{"prompt_tokens":24,"completion_tokens":7}', '{"model_key":"fixture-model"}', NULL);"#
        ).unwrap();
        drop(db);
        let databases = vec![db_path.to_str().unwrap().to_owned()];
        let mut restarted = Delegations::load(state.get(KEY), at + 6000);
        let mut output = Vec::new();
        restarted
            .resolve(
                &mut output,
                databases.clone(),
                at + 6000,
                &mut ScanBudget::default(),
                &AtomicBool::new(false),
            )
            .await;
        assert!(output
            .iter()
            .any(|row| row["event.name"] == "gen_ai.agent.invoke"));
        assert!(output
            .iter()
            .any(|row| row["event.name"] == "gen_ai.agent.result"));
        let response = output
            .iter()
            .find(|row| row["event.name"] == "llm.response")
            .unwrap();
        assert_eq!(response["gen_ai.response.id"], "assistant-native");
        assert_eq!(response["gen_ai.usage.input_tokens"], 24);
        assert_eq!(response["gen_ai.agent.parent.id"], "parent");
        assert_eq!(response["parent_span_id"], span);
        assert_eq!(response["gen_ai.request.id"], "native-request");
        assert!(response["gen_ai.output.messages"]
            .to_string()
            .contains("verified child answer"));
        restarted.save(&mut state).unwrap();
        assert!(!state.to_string().contains("verified child answer"));
        let mut restarted = Delegations::load(state.get(KEY), at + 12_000);
        output.clear();
        restarted
            .resolve(
                &mut output,
                databases,
                at + 12_000,
                &mut ScanBudget::default(),
                &AtomicBool::new(false),
            )
            .await;
        assert!(output.is_empty());
    }
}
