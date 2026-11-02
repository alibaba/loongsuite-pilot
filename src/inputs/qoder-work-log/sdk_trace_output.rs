//! Bounded checkpoint identity and the SDK span-tree emitter.
use super::sdk_trace_model::{Session, Window};
use crate::checkpoints::InputState;
use crate::inputs::base::{query_readonly, InputRuntime};
use crate::normalization::build_agent_activity_entry;
use crate::types::AgentActivityEntry;
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;

const STATE_FIELD: &str = "qoderWorkSdkTraceState";
const STATE_LIMIT: usize = 500;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WindowCheckpoint {
    schema: u8,
    emitted_window_keys: Vec<String>,
    consumed_prompt_ids: Vec<String>,
    turn_counters: indexmap::IndexMap<String, u64>,
}
impl Default for WindowCheckpoint {
    fn default() -> Self {
        Self {
            schema: 1,
            emitted_window_keys: Vec::new(),
            consumed_prompt_ids: Vec::new(),
            turn_counters: indexmap::IndexMap::new(),
        }
    }
}
impl WindowCheckpoint {
    pub fn load(state: &InputState) -> Result<Self> {
        if let Some(value) = state.get_field(STATE_FIELD) {
            let result: Self = serde_json::from_value(value)?;
            if result.schema != 1 {
                return Err(anyhow!("unsupported SDK trace checkpoint schema"));
            }
            return Ok(result);
        }
        let mut result = Self::default();
        let extra = state.extra().unwrap_or(Value::Null);
        for (key, target) in [
            ("emittedWindowKeys", &mut result.emitted_window_keys),
            ("consumedPromptIds", &mut result.consumed_prompt_ids),
        ] {
            *target = extra
                .get(key)
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|v| v.as_str().filter(|s| !s.is_empty()).map(str::to_owned))
                .collect();
        }
        if let Some(counters) = extra.get("turnCounters").and_then(Value::as_object) {
            for (id, value) in counters {
                let counter = value.as_u64().or_else(|| {
                    value
                        .as_f64()
                        .filter(|n| {
                            n.is_finite()
                                && *n >= 0.0
                                && *n < 18446744073709551616.0
                                && n.fract() == 0.0
                        })
                        .map(|n| n as u64)
                });
                if let Some(counter) = counter {
                    result.turn_counters.insert(id.clone(), counter);
                }
            }
        }
        result.cap();
        Ok(result)
    }
    fn cap(&mut self) {
        if self.emitted_window_keys.len() > STATE_LIMIT {
            self.emitted_window_keys
                .drain(..self.emitted_window_keys.len() - STATE_LIMIT);
        }
        if self.consumed_prompt_ids.len() > STATE_LIMIT {
            self.consumed_prompt_ids
                .drain(..self.consumed_prompt_ids.len() - STATE_LIMIT);
        }
        while self.turn_counters.len() > STATE_LIMIT {
            self.turn_counters.shift_remove_index(0);
        }
    }
    pub fn persist(&mut self, rt: &InputRuntime) -> Result<()> {
        self.cap();
        let state = rt.state();
        let mut value = state
            .get_field(STATE_FIELD)
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();
        for (key, item) in serde_json::to_value(&self)?.as_object().unwrap() {
            value.insert(key.clone(), item.clone());
        }
        rt.state_store.set(
            rt.id.as_str(),
            state.with_checkpoint_extension(STATE_FIELD, Value::Object(value)),
        );
        Ok(())
    }
}
#[derive(Clone)]
struct Prompt {
    id: String,
    text: String,
    time: i64,
    sequence: f64,
}
#[derive(Default)]
struct DbData {
    prompts: Vec<Prompt>,
    results: HashMap<String, String>,
}
fn string(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).unwrap_or("").to_owned()
}
fn user_text(message: &Value) -> String {
    if let Some(text) = message.get("content").and_then(Value::as_str) {
        return text.to_owned();
    }
    message
        .get("parts")
        .or_else(|| message.get("content"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|p| {
            p.get("text")
                .or_else(|| p.get("content"))
                .and_then(Value::as_str)
        })
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}
fn collect_results(parts: &Value, results: &mut HashMap<String, String>) {
    for part in parts.as_array().into_iter().flatten() {
        let kind = part.get("type").and_then(Value::as_str).unwrap_or("");
        if !kind.starts_with("tool-") || kind == "tool-Thinking" {
            continue;
        }
        let id = ["toolCallId", "tool_call_id", "id"]
            .iter()
            .find_map(|key| part.get(*key).and_then(Value::as_str))
            .unwrap_or("");
        let result = part.get("output").or_else(|| part.get("result"));
        let result = result
            .map(|v| {
                v.as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| v.to_string())
            })
            .unwrap_or_default();
        if !id.is_empty() && !result.is_empty() {
            results.entry(id.to_owned()).or_insert(result);
        }
    }
}
fn millis(value: Option<&Value>) -> i64 {
    let Some(value) = value else {
        return 0;
    };
    let number = value
        .as_f64()
        .or_else(|| value.as_str().and_then(|s| s.parse::<f64>().ok()));
    if let Some(number) = number.filter(|n| n.is_finite()) {
        return if number > 1e12 {
            number as i64
        } else {
            (number * 1000.0) as i64
        };
    }
    value
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|t| t.timestamp_millis())
        .unwrap_or(0)
}
async fn read_db(path: &str, id: &str) -> DbData {
    if tokio::fs::metadata(path).await.is_err() {
        return DbData::default();
    }
    let mut data = DbData::default();
    let first=query_readonly(path,"SELECT sc.messages FROM sub_chats sc WHERE sc.session_id = ? AND sc.messages IS NOT NULL AND sc.messages != '[]' LIMIT 2000",&[json!(id)]).await;
    match first {
        Ok(rows) => {
            for row in rows {
                let Some(messages) = row
                    .get("messages")
                    .and_then(Value::as_str)
                    .and_then(|v| serde_json::from_str::<Value>(v).ok())
                else {
                    continue;
                };
                for (index, message) in messages.as_array().into_iter().flatten().enumerate() {
                    if message.get("role").and_then(Value::as_str) == Some("user") {
                        let text = user_text(message);
                        if !text.is_empty() {
                            data.prompts.push(Prompt {
                                id: message
                                    .get("id")
                                    .or_else(|| message.get("uuid"))
                                    .and_then(Value::as_str)
                                    .map(str::to_owned)
                                    .unwrap_or_else(|| format!("subchat-{index}")),
                                text,
                                time: millis(
                                    message
                                        .get("timestamp")
                                        .or_else(|| message.get("created_at")),
                                ),
                                sequence: index as f64,
                            });
                        }
                    } else if message.get("role").and_then(Value::as_str) == Some("assistant") {
                        if let Some(parts) = message.get("parts") {
                            collect_results(parts, &mut data.results);
                        }
                    }
                }
            }
        }
        Err(error) if error.contains("no such column") => {}
        Err(_) => return data,
    }
    if data.prompts.is_empty() && data.results.is_empty() {
        if let Ok(rows)=query_readonly(path,"SELECT m.id,m.role,m.parts,m.updated_at AS updatedAt,m.sequence FROM messages m JOIN sub_chats sc ON m.sub_chat_id=sc.id WHERE sc.session_id=? AND m.parts IS NOT NULL AND m.parts!='' AND m.parts!='[]' ORDER BY m.sequence,m.updated_at LIMIT 2000",&[json!(id)]).await{
            for row in rows{
                let Some(parts)=row.get("parts").and_then(Value::as_str).and_then(|v|serde_json::from_str::<Value>(v).ok())else{continue;};
                if row.get("role").and_then(Value::as_str)==Some("user"){
                    let text=user_text(&json!({"parts":parts}));
                    if !text.is_empty(){data.prompts.push(Prompt{id:string(row.get("id")),text,time:row.get("updatedAt").and_then(Value::as_f64).filter(|v|*v>0.0).map(|v|(v*1000.0)as i64).unwrap_or(0),sequence:row.get("sequence").and_then(Value::as_f64).unwrap_or(0.0)});}
                }else{collect_results(&parts,&mut data.results);}
            }
        }
    }
    data.prompts
        .sort_by(|a, b| a.sequence.total_cmp(&b.sequence).then(a.time.cmp(&b.time)));
    data
}
fn safe_json(text: &str) -> Option<Value> {
    if text.is_empty() {
        None
    } else {
        Some(serde_json::from_str(text).unwrap_or_else(|_| json!(text)))
    }
}
fn nano(time: i64) -> String {
    (i128::from(time) * 1_000_000).to_string()
}
fn physical_key(window: &Window) -> String {
    let id = &window.session_id;
    if !window.result_id.is_empty() {
        return format!("{id}:result:{}", window.result_id);
    }
    if let Some(message) = window
        .session
        .turns
        .iter()
        .rev()
        .map(|t| &t.message_id)
        .find(|m| !m.is_empty())
    {
        return format!("{id}:last-message:{message}");
    }
    if let Some(time) = window.result_time {
        return format!("{id}:result-ts:{time}");
    }
    format!(
        "{id}:window:{}:{}",
        window.session.start, window.session.seen
    )
}
fn prompt_for<'a>(
    session: &Session,
    result: Option<i64>,
    data: &'a DbData,
    state: &WindowCheckpoint,
) -> Option<&'a Prompt> {
    let start = session
        .turns
        .first()
        .map(|t| t.start)
        .unwrap_or(session.start);
    let end = result.unwrap_or(session.seen);
    let upper = start.max(end).saturating_add(30_000);
    let mut candidates = data
        .prompts
        .iter()
        .filter(|p| {
            !p.id.is_empty()
                && !state.consumed_prompt_ids.contains(&p.id)
                && (p.time == 0 || p.time <= upper)
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|a, b| {
        let distance = |p: &Prompt| {
            if p.time > 0 {
                p.time.abs_diff(start)
            } else {
                u64::MAX
            }
        };
        distance(a)
            .cmp(&distance(b))
            .then(a.sequence.total_cmp(&b.sequence))
    });
    if let Some(prompt) = candidates.first() {
        return Some(*prompt);
    }
    data.prompts
        .iter()
        .filter(|p| !state.consumed_prompt_ids.contains(&p.id) && p.time > 0)
        .map(|p| (p, p.time.abs_diff(start).min(p.time.abs_diff(end))))
        .filter(|(_, d)| *d <= 5 * 60 * 1000)
        .min_by(|a, b| a.1.cmp(&b.1).then(a.0.sequence.total_cmp(&b.0.sequence)))
        .map(|(p, _)| p)
}
pub(super) async fn emit(
    window: Window,
    rt: &InputRuntime,
    db: &str,
    projects: &std::path::Path,
    source: &str,
    checkpoint: &mut WindowCheckpoint,
) -> Result<Vec<AgentActivityEntry>> {
    if window.session.turns.is_empty() {
        return Ok(Vec::new());
    }
    let key = physical_key(&window);
    if checkpoint.emitted_window_keys.contains(&key) {
        return Ok(Vec::new());
    }
    let mut policy = Map::new();
    policy.insert("gen_ai.agent.type".into(), json!(rt.agent_type.as_str()));
    policy.insert("gen_ai.session.id".into(), json!(window.session_id));
    policy.insert("workspace.path".into(), json!(window.session.cwd));
    if !rt.with_workspace_policy(|p| p.allows(&policy, rt.agent_type.as_str())) {
        return Ok(Vec::new());
    }
    let data = read_db(db, &window.session_id).await;
    let prompt = prompt_for(&window.session, window.result_time, &data, checkpoint).cloned();
    let (turn_id, counter) = if let Some(prompt) = &prompt {
        (format!("{}:{}", window.session_id, prompt.id), None)
    } else {
        let counter = checkpoint
            .turn_counters
            .get(&window.session_id)
            .copied()
            .unwrap_or(0)
            .checked_add(1)
            .ok_or_else(|| anyhow!("SDK turn counter exhausted"))?;
        (format!("{}:t{counter}", window.session_id), Some(counter))
    };
    let mut results = window.tool_results.clone();
    for (id, result) in data.results {
        results.entry(id).or_insert(result);
    }
    for turn in &window.session.turns {
        for tool in &turn.tools {
            if !results.contains_key(&tool.id) {
                if let Some(text) = read_tool_file(
                    projects,
                    &window.session_id,
                    &tool.id,
                    window.transcript_path.as_deref(),
                )
                .await
                {
                    results.insert(tool.id.clone(), text);
                }
            }
        }
    }
    let trace = hex::encode(uuid::Uuid::new_v4().as_bytes());
    let base = json!({"trace_id":trace,"gen_ai.session.id":window.session_id,"gen_ai.turn.id":turn_id,"gen_ai.agent.type":rt.agent_type.as_str(),"workspace.path":window.session.cwd,"attributes":{"source":source}});
    let mut entries = Vec::new();
    let mut other = base.clone();
    other["event.name"] = json!("other");
    other["gen_ai.step.id"] = json!(format!("{turn_id}:s1"));
    let first = window.session.turns[0].start;
    other["time_unix_nano"] = json!(nano(
        prompt
            .as_ref()
            .filter(|p| p.time > 0)
            .map(|p| p.time)
            .unwrap_or_else(|| if window.session.start < first {
                window.session.start
            } else {
                first.saturating_sub(100)
            })
    ));
    if let Some(prompt) = prompt.as_ref() {
        other["gen_ai.input.messages_delta"] =
            json!([{"role":"user","parts":[{"type":"text","content":prompt.text}]}]);
    }
    entries.push(build_agent_activity_entry(&other));
    let mut groups = Vec::new();
    for (index, turn) in window.session.turns.iter().enumerate() {
        let start_index = entries.len();
        let step = format!("{turn_id}:s{}", index + 1);
        let mut fields = base.clone();
        fields["gen_ai.step.id"] = json!(step);
        fields["gen_ai.request.model"] = json!(turn.model);
        let mut request = fields.clone();
        request["event.name"] = json!("llm.request");
        request["time_unix_nano"] = json!(nano(turn.start));
        if index == 0 {
            if let Some(prompt) = &prompt {
                request["gen_ai.input.messages_delta"] =
                    json!([{"role":"user","parts":[{"type":"text","content":prompt.text}]}]);
            }
        } else {
            let previous = &window.session.turns[index - 1];
            let mut calls = Vec::new();
            let mut responses = Vec::new();
            for tool in &previous.tools {
                let mut part = json!({"type":"tool_call","id":tool.id,"name":tool.name});
                if let Some(arguments) = safe_json(&tool.arguments) {
                    part["arguments"] = arguments;
                }
                calls.push(part);
                if let Some(result) = results.get(&tool.id).filter(|v| !v.is_empty()) {
                    responses
                        .push(json!({"type":"tool_call_response","id":tool.id,"response":result}));
                }
            }
            if !responses.is_empty() {
                request["gen_ai.input.messages_delta"] =
                    json!([{"role":"assistant","parts":calls},{"role":"tool","parts":responses}]);
            }
        }
        entries.push(build_agent_activity_entry(&request));
        let mut parts = Vec::new();
        if !turn.thinking.is_empty() {
            parts.push(json!({"type":"reasoning","content":turn.thinking}));
        }
        if !turn.text.is_empty() {
            parts.push(json!({"type":"text","content":turn.text}));
        }
        for tool in &turn.tools {
            let mut part = json!({"type":"tool_call","id":tool.id,"name":tool.name});
            if let Some(args) = safe_json(&tool.arguments) {
                part["arguments"] = args;
            }
            parts.push(part);
        }
        let finish = if !turn.tools.is_empty() {
            "tool_calls"
        } else if index + 1 == window.session.turns.len() {
            "end_turn"
        } else {
            "stop"
        };
        let mut response = fields.clone();
        response["event.name"] = json!("llm.response");
        response["time_unix_nano"] = json!(nano(turn.end));
        response["gen_ai.response.id"] = json!(turn.message_id);
        response["gen_ai.response.model"] = json!(turn.model);
        response["gen_ai.response.finish_reasons"] = json!([finish]);
        if turn.input > 0 {
            response["gen_ai.usage.input_tokens"] = json!(turn.input);
        }
        if turn.output > 0 {
            response["gen_ai.usage.output_tokens"] = json!(turn.output);
        }
        if turn.input > 0 || turn.output > 0 {
            response["gen_ai.usage.total_tokens"] = json!(turn.input.saturating_add(turn.output));
        }
        if !parts.is_empty() {
            response["gen_ai.output.messages"] =
                json!([{"role":"assistant","parts":parts,"finish_reason":finish}]);
        }
        entries.push(build_agent_activity_entry(&response));
        for tool in &turn.tools {
            let mut call = fields.clone();
            call["event.name"] = json!("tool.call");
            call["time_unix_nano"] = json!(nano(tool.start));
            call["gen_ai.tool.name"] = json!(tool.name);
            call["gen_ai.tool.call.id"] = json!(tool.id);
            if let Some(args) = safe_json(&tool.arguments) {
                call["gen_ai.tool.call.arguments"] = args;
            }
            entries.push(build_agent_activity_entry(&call));
            let mut result = fields.clone();
            result["event.name"] = json!("tool.result");
            result["time_unix_nano"] = json!(nano(tool.end));
            result["gen_ai.tool.name"] = json!(tool.name);
            result["gen_ai.tool.call.id"] = json!(tool.id);
            if let Some(text) = results.get(&tool.id) {
                result["gen_ai.tool.call.result"] = json!(text);
            }
            if tool.end > tool.start {
                result["gen_ai.tool.call.duration"] = json!(tool.end - tool.start);
            }
            entries.push(build_agent_activity_entry(&result));
        }
        groups.push((start_index, entries.len(), turn.start));
    }
    for pair in groups.windows(2) {
        let next = i128::from(pair[1].2) * 1_000_000;
        let cap = (next - 1_000_000).to_string();
        for entry in &mut entries[pair[0].0..pair[0].1] {
            if entry
                .event_name
                .is_some_and(|v| v.as_str() == "tool.result")
                && entry.time_unix_nano.parse::<i128>().is_ok_and(|t| t > next)
            {
                entry.time_unix_nano = cap.clone();
            }
        }
    }
    checkpoint.emitted_window_keys.push(key);
    if let Some(prompt) = prompt {
        checkpoint.consumed_prompt_ids.push(prompt.id);
    }
    if let Some(counter) = counter {
        checkpoint.turn_counters.insert(window.session_id, counter);
    }
    checkpoint.persist(rt)?;
    Ok(entries)
}
fn safe_component(value: &str) -> bool {
    !value.is_empty() && value != "." && value != ".." && !value.contains(['/', '\\', '\0'])
}
async fn read_tool_file(
    projects: &std::path::Path,
    session: &str,
    id: &str,
    transcript: Option<&str>,
) -> Option<String> {
    if !safe_component(session) || !safe_component(id) {
        return None;
    }
    let root = tokio::fs::canonicalize(projects).await.ok()?;
    let mut candidates = Vec::new();
    if let Some(parent) = transcript.and_then(|p| std::path::Path::new(p).parent()) {
        candidates.push(
            parent
                .join(session)
                .join("tool-results")
                .join(format!("{id}.txt")),
        );
    }
    if let Ok(mut directories) = tokio::fs::read_dir(&root).await {
        while let Ok(Some(directory)) = directories.next_entry().await {
            if directory
                .file_type()
                .await
                .ok()
                .is_some_and(|kind| kind.is_dir())
            {
                candidates.push(
                    directory
                        .path()
                        .join(session)
                        .join("tool-results")
                        .join(format!("{id}.txt")),
                );
            }
        }
    }
    for path in candidates {
        let path = path.clone();
        let root = root.clone();
        let text = tokio::task::spawn_blocking(move || {
            use std::io::Read;
            let canonical = std::fs::canonicalize(&path).ok()?;
            if !canonical.starts_with(&root) {
                return None;
            }
            let mut options = std::fs::OpenOptions::new();
            options.read(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                options.custom_flags(
                    windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT,
                );
            }
            let file = options.open(&canonical).ok()?;
            let metadata = file.metadata().ok()?;
            if !metadata.is_file() || metadata.len() > 16 * 1024 * 1024 {
                return None;
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if metadata.file_attributes()
                    & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
                    != 0
                {
                    return None;
                }
            }
            let actual = crate::utils::file_identity::path_from_opened_file(&file).ok()?;
            if !actual.starts_with(&root) {
                return None;
            }
            let mut bytes = Vec::new();
            file.take(16 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .ok()?;
            if bytes.len() > 16 * 1024 * 1024 {
                return None;
            }
            Some(String::from_utf8_lossy(&bytes).into_owned())
        })
        .await
        .ok()
        .flatten();
        if text.is_some() {
            return text;
        }
    }
    None
}
