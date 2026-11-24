mod model;

use super::common::{
    data_dir, load_runtime_config, log_hook_error, record_upstream_context_once, sanitize_record,
    sha256_hex, with_file_lock, write_empty, write_jsonl_records, Env, HookRequest, Obj,
};
use model::{text, Model};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::fs;
use std::io::{self, Read, Write};
use std::path::Path;

const AGENT: &str = "trae-cn";
const MAX_STATE: u64 = 8 * 1024 * 1024;
const TTL_SECONDS: f64 = 43_200.0;
const MAX_TOOLS: usize = 256;

#[derive(Default, Deserialize, Serialize)]
#[serde(default)]
struct Session {
    session_id: String,
    cwd: String,
    turn_index: u64,
    #[serde(flatten)]
    model: Model,
    last_activity_at_sec: f64,
    trace_id: String,
    turn_id: String,
    step_id: String,
    turn_started_at: String,
    stop_count: u64,
    llm_request_emitted: bool,
    llm_response_emitted: bool,
    turn_synthesized: bool,
    prompt: String,
    usage: Map<String, Value>,
    pending_tool_calls: indexmap::IndexMap<String, Tool>,
    tool_seq: usize,
    #[serde(skip_serializing_if = "String::is_empty")]
    entry_span_id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    agent_span_id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    step_span_id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    llm_span_id: String,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(default)]
struct Tool {
    span_id: String,
    name: String,
    call_time: String,
    arguments: Value,
    completed: bool,
}

pub fn run(request: &mut HookRequest<'_>) -> i32 {
    if let Some(event) = request.args.first().map(String::as_str) {
        if let Err(error) = collect(event, request.stdin, request.env) {
            log_hook_error(request.env, AGENT, event, "collection_io", &error);
        }
    }
    write_empty(request.stdout);
    0
}

fn collect(event: &str, input: &[u8], env: &Env) -> Result<(), String> {
    if !matches!(
        event,
        "session-start"
            | "user-prompt-submit"
            | "pre-tool-use"
            | "post-tool-use"
            | "stop"
            | "notification"
    ) {
        return Ok(());
    }
    let Ok(payload) = serde_json::from_slice::<Value>(input) else {
        return Ok(());
    };
    let Some(id) = text(&payload["session_id"]).filter(|id| id.len() <= 512) else {
        return Ok(());
    };
    if matches!(event, "session-start" | "user-prompt-submit" | "stop") {
        record_upstream_context_once(env, AGENT, id);
    }
    let data = data_dir(env);
    let turns = data.join("state/trae-cn/turns");
    let file = turns.join(format!("{}.json", sha256_hex(id.as_bytes())));
    let lock = file.with_extension("json.lock");
    crate::utils::source_access::private_path(&file).map_err(|e| e.to_string())?;
    crate::utils::source_access::private_path(&lock).map_err(|e| e.to_string())?;
    with_file_lock(&lock, 1_500, 300_000, || {
        let now = chrono::Utc::now().timestamp_millis() as f64 / 1_000.0;
        let mut session = load(&file, id, now)?;
        let capture = content_enabled(env);
        if !capture {
            session.remove_content();
        }
        let config = load_runtime_config(env);
        let at = text(&payload["timestamp"])
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .and_then(|date| date.timestamp_nanos_opt())
            .unwrap_or_else(|| chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default());
        let rows = session.on_event(event, &payload, at, env, &config.user_id, capture);
        let mut records: Vec<_> = rows
            .into_iter()
            .filter_map(|value| value.as_object().cloned())
            .map(sanitize_record)
            .collect();
        if !capture {
            for record in &mut records {
                for key in [
                    "gen_ai.input.messages",
                    "gen_ai.input.messages_delta",
                    "gen_ai.input.messages_hash",
                    "gen_ai.output.messages",
                    "gen_ai.tool.call.arguments",
                    "gen_ai.tool.call.result",
                    "error.message",
                ] {
                    record.remove(key);
                }
            }
        }
        write_jsonl_records(env, &data.join("logs/trae-cn/history"), AGENT, &records)?;
        session.last_activity_at_sec = now;
        save(&turns, &file, &session).map_err(|err| err.to_string())
    })
    .ok_or_else(|| "Timed out acquiring the TRAE session lock".to_owned())?
}

fn load(path: &Path, session: &str, now: f64) -> Result<Session, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            return Ok(Session {
                session_id: session.into(),
                ..Session::default()
            })
        }
        Err(err) => return Err(err.to_string()),
    };
    let mut buffer = Vec::new();
    file.take(MAX_STATE + 1)
        .read_to_end(&mut buffer)
        .map_err(|err| err.to_string())?;
    if buffer.len() as u64 > MAX_STATE {
        return Err("TRAE session state exceeds its size limit".into());
    }
    let state: Session = serde_json::from_slice(&buffer).map_err(|err| err.to_string())?;
    if state.session_id != session {
        return Err("TRAE session state does not match the Hook session".into());
    }
    if state.last_activity_at_sec > 0.0 && now - state.last_activity_at_sec > TTL_SECONDS {
        return Ok(Session {
            session_id: session.into(),
            turn_index: state.turn_index,
            ..Session::default()
        });
    }
    Ok(state)
}

fn save(directory: &Path, file: &Path, state: &Session) -> io::Result<()> {
    fs::create_dir_all(directory)?;
    let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
    serde_json::to_writer(&mut temporary, state)?;
    temporary.flush()?;
    temporary.persist(file).map_err(|err| err.error)?;
    Ok(())
}

pub(crate) fn content_enabled(env: &Env) -> bool {
    let (path, explicit) = super::common::hook_config_path(env);
    match fs::read_to_string(path) {
        Ok(json) => serde_json::from_str::<Value>(json.trim_start_matches('\u{feff}'))
            .ok()
            .filter(Value::is_object)
            .is_some_and(|config| {
                let setting = &config["agents"][AGENT]["captureMessageContent"];
                setting.as_bool().unwrap_or_else(|| {
                    !setting.as_str().is_some_and(|value| {
                        matches!(
                            value.trim().to_ascii_lowercase().as_str(),
                            "false" | "0" | "off"
                        )
                    })
                })
            }),
        Err(error) => !explicit && error.kind() == io::ErrorKind::NotFound,
    }
}

impl Session {
    fn remove_content(&mut self) {
        self.prompt.clear();
        for tool in self.pending_tool_calls.values_mut() {
            tool.arguments = Value::Null;
        }
    }

    fn on_event(
        &mut self,
        event: &str,
        payload: &Value,
        at: i64,
        env: &Env,
        user: &str,
        capture: bool,
    ) -> Vec<Value> {
        let mut rows = Vec::new();
        if let Some(cwd) = text(&payload["cwd"]) {
            self.cwd = cwd.chars().take(4096).collect();
        }
        match event {
            "user-prompt-submit" => {
                if self.llm_request_emitted && !self.llm_response_emitted {
                    self.finish(&mut rows, at, user, "", capture);
                }
                self.start(&mut rows, payload, at, env, user, (false, capture));
            }
            "pre-tool-use" => {
                let Some(id) = tool_id(payload) else {
                    return rows;
                };
                if !self.llm_request_emitted || self.llm_response_emitted {
                    self.start(&mut rows, payload, at, env, user, (true, capture));
                }
                self.observe_usage(payload);
                if self.pending_tool_calls.contains_key(id)
                    || self.pending_tool_calls.len() >= MAX_TOOLS
                {
                    return rows;
                }
                let span = id_digest(&self.trace_id, "tool", id, 16);
                let name = text(&payload["tool_name"])
                    .or_else(|| text(&payload["llm_tool_name"]))
                    .unwrap_or("unknown");
                let args = if capture {
                    bounded(&payload["tool_input"])
                } else {
                    Value::Null
                };
                self.tool_seq = self.tool_seq.saturating_add(1);
                let row = self.row(
                    "tool.call",
                    "TOOL",
                    &span,
                    &self.step_span_id,
                    at,
                    at,
                    user,
                    id,
                );
                let mut tool = Tool {
                    span_id: span,
                    name: name.into(),
                    call_time: at.to_string(),
                    arguments: args,
                    completed: false,
                };
                rows.push(Self::tool_row(row, &tool, id, self.tool_seq));
                if !capture {
                    tool.arguments = Value::Null;
                }
                self.pending_tool_calls.insert(id.into(), tool);
            }
            "post-tool-use" if self.llm_request_emitted => {
                let Some(id) = tool_id(payload) else {
                    return rows;
                };
                let Some(tool) = self
                    .pending_tool_calls
                    .get(id)
                    .filter(|tool| !tool.completed)
                else {
                    return rows;
                };
                let mut row = Self::tool_row(
                    self.row(
                        "tool.result",
                        "TOOL",
                        &tool.span_id,
                        &self.step_span_id,
                        tool.call_time.parse().unwrap_or(at),
                        at,
                        user,
                        id,
                    ),
                    tool,
                    id,
                    self.tool_seq,
                );
                let result = &payload["tool_response"];
                let (failed, source) = tool_status(result);
                row["tool.result.status"] = json!(if failed { "error" } else { "success" });
                row["agent.trae.status_source"] = json!(source);
                if capture {
                    row["gen_ai.tool.call.result"] = if empty(result) {
                        json!("no_response_captured")
                    } else {
                        bounded(result)
                    };
                    if failed {
                        row["error.message"] = json!(text(&result["error"])
                            .map(safe_text)
                            .unwrap_or_else(|| "tool execution failed".into()));
                    }
                }
                if failed {
                    row["error.type"] = json!("ToolError");
                }
                self.pending_tool_calls[id].completed = true;
                self.observe_usage(payload);
                rows.push(row);
            }
            "stop" => {
                if !self.llm_request_emitted {
                    self.start(&mut rows, payload, at, env, user, (true, capture));
                }
                if !self.llm_response_emitted {
                    self.model.update(payload, env);
                    self.observe_usage(payload);
                    self.stop_count = self.stop_count.saturating_add(1);
                    self.finish(
                        &mut rows,
                        at,
                        user,
                        text(&payload["last_assistant_message"]).unwrap_or(""),
                        capture,
                    );
                }
            }
            "notification" if payload["notification_type"] == "idle_prompt" => {
                if self.llm_request_emitted && !self.llm_response_emitted {
                    self.finish(&mut rows, at, user, "", capture);
                }
                self.remove_content();
            }
            "notification" if !self.llm_response_emitted => self.observe_usage(payload),
            _ => {}
        }
        rows
    }

    fn start(
        &mut self,
        rows: &mut Vec<Value>,
        payload: &Value,
        at: i64,
        env: &Env,
        user: &str,
        (synthetic, capture): (bool, bool),
    ) {
        self.turn_index = self.turn_index.saturating_add(1);
        self.turn_id = format!("{}:t{}", self.session_id, self.turn_index);
        self.step_id = format!("{}:s1", self.turn_id);
        self.trace_id = id_digest(&self.turn_id, "trace", &at.to_string(), 32);
        self.entry_span_id = id_digest(&self.trace_id, "entry", "", 16);
        self.agent_span_id = id_digest(&self.trace_id, "agent", "", 16);
        self.step_span_id = id_digest(&self.trace_id, "step", "", 16);
        self.llm_span_id = id_digest(&self.trace_id, "llm", "", 16);
        self.turn_started_at = at.to_string();
        self.stop_count = 0;
        self.tool_seq = 0;
        self.llm_request_emitted = true;
        self.llm_response_emitted = false;
        self.turn_synthesized = synthetic;
        self.usage.clear();
        self.pending_tool_calls.clear();
        self.model.update(payload, env);
        self.observe_usage(payload);
        let prompt = text(&payload["prompt"]).unwrap_or_default();
        self.prompt = if capture {
            safe_text(prompt)
        } else {
            String::new()
        };
        let mut entry = self.row(
            "other",
            "ENTRY",
            &self.entry_span_id,
            "",
            at,
            at,
            user,
            "entry",
        );
        entry["agent.trae.session_start"] = json!(true);
        entry["agent.trae.turn_synthesized"] = json!(synthetic);
        if !prompt.is_empty() {
            entry["agent.pilot.correlation.content_hash"] =
                json!(&sha256_hex(prompt.as_bytes())[..16]);
        }
        rows.extend([
            entry,
            self.row(
                "other",
                "AGENT",
                &self.agent_span_id,
                &self.entry_span_id,
                at,
                at,
                user,
                "agent",
            ),
            self.row(
                "other",
                "STEP",
                &self.step_span_id,
                &self.agent_span_id,
                at,
                at,
                user,
                "step",
            ),
        ]);
        let mut request = self.llm_row("llm.request", at, at, user);
        request["gen_ai.turn.start"] = json!(true);
        if capture {
            let input = input_message(&self.prompt);
            request["gen_ai.input.messages_hash"] = json!(sha256_hex(input.to_string().as_bytes()));
            request["gen_ai.input.messages_delta"] = input.clone();
            request["gen_ai.input.messages"] = input;
        }
        rows.push(request);
    }

    fn finish(&mut self, rows: &mut Vec<Value>, at: i64, user: &str, answer: &str, capture: bool) {
        let started = self.turn_started_at.parse().unwrap_or(at);
        let mut response = self.llm_row("llm.response", started, at, user);
        response["gen_ai.turn.end"] = json!(true);
        response["gen_ai.response.model"] = json!(self.model.display());
        response["gen_ai.response.finish_reasons"] = json!(["stop"]);
        response["agent.trae.stop_count"] = json!(self.stop_count);
        response["agent.trae.finish_reason_raw"] = json!("stop");
        if !self.pending_tool_calls.is_empty() {
            response["agent.trae-cn.tool_call_ids"] =
                json!(self.pending_tool_calls.keys().collect::<Vec<_>>());
        }
        for (key, value) in &self.usage {
            response[key] = value.clone();
        }
        if capture {
            let mut output = Vec::with_capacity(2);
            if !self.pending_tool_calls.is_empty() {
                let tools: Vec<_> = self.pending_tool_calls.iter().map(|(id, tool)| {
                    json!({"type":"tool_call","id":id,"name":tool.name,"tool_name":tool.name,"arguments":tool.arguments})
                }).collect();
                output.push(json!({"role":"assistant","parts":tools}));
            }
            output.push(
                json!({"role":"assistant","parts":[{"type":"text","content":safe_text(answer)}]}),
            );
            response["gen_ai.output.messages"] = json!(output);
            let input = input_message(&self.prompt);
            response["gen_ai.input.messages_hash"] =
                json!(sha256_hex(input.to_string().as_bytes()));
            response["gen_ai.input.messages"] = input;
        }
        rows.push(response);
        self.llm_response_emitted = true;
        self.prompt.clear();
        self.pending_tool_calls.retain(|_, tool| !tool.completed);
    }

    fn observe_usage(&mut self, event: &Value) {
        if let Some(metrics) = usage(event) {
            self.usage.extend(metrics);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn row(
        &self,
        event: &str,
        kind: &str,
        span: &str,
        parent: &str,
        start: i64,
        at: i64,
        user: &str,
        key: &str,
    ) -> Value {
        let name = match kind {
            "ENTRY" => "enter",
            "AGENT" => "invoke_agent",
            "STEP" => "react",
            "LLM" => "chat",
            _ => "execute_tool",
        };
        json!({
            "event.id": id_digest(&self.trace_id, event, key, 32),
            "event.name": event,
            "time_unix_nano": at.to_string(),
            "startTimeUnixNano": start.to_string(),
            "endTimeUnixNano": at.max(start.saturating_add(1)).to_string(),
            "trace_id": self.trace_id,
            "span_id": span,
            "parent_span_id": parent,
            "user.id": user,
            "gen_ai.user.id": user,
            "gen_ai.system": AGENT,
            "gen_ai.framework": "trae",
            "gen_ai.agent.type": AGENT,
            "gen_ai.agent.id": self.session_id,
            "gen_ai.agent.name": AGENT,
            "gen_ai.session.id": self.session_id,
            "gen_ai.conversation.id": self.session_id,
            "gen_ai.turn.id": self.turn_id,
            "gen_ai.step.id": self.step_id,
            "gen_ai.span.kind": kind,
            "gen_ai.operation.name": name,
            "gen_ai.provider.name": self.model.provider(),
            "gen_ai.request.model": self.model.name(),
            "agent.trae-cn.cwd": self.cwd,
            "process.cwd": self.cwd,
        })
    }

    fn llm_row(&self, event: &str, start: i64, at: i64, user: &str) -> Value {
        let mut row = self.row(
            event,
            "LLM",
            &self.llm_span_id,
            &self.step_span_id,
            start,
            at,
            user,
            "",
        );
        row["gen_ai.response.id"] = json!(format!("{}:r", self.step_id));
        row
    }

    fn tool_row(mut row: Value, tool: &Tool, id: &str, seq: usize) -> Value {
        row["gen_ai.tool.name"] = json!(tool.name);
        row["gen_ai.tool.call.id"] = json!(id);
        row["gen_ai.tool.call.arguments"] = tool.arguments.clone();
        row["agent.trae.tool_seq"] = json!(seq);
        row
    }
}

fn input_message(prompt: &str) -> Value {
    json!([{"role":"user","parts":[{"type":"text","content":prompt}]}])
}

fn tool_id(payload: &Value) -> Option<&str> {
    text(&payload["tool_use_id"]).filter(|id| id.len() <= 256)
}

pub(crate) fn id_digest(namespace: &str, kind: &str, id: &str, len: usize) -> String {
    sha256_hex(format!("{namespace}\0{kind}\0{id}").as_bytes())[..len].into()
}

fn safe_text(value: &str) -> String {
    let mut end = value.len().min(32_000);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

fn bounded(value: &Value) -> Value {
    if let Some(text) = value.as_str() {
        return json!(safe_text(text));
    }
    let json = value.to_string();
    if json.len() <= 32_000 {
        value.clone()
    } else {
        json!(safe_text(&json))
    }
}

fn empty(value: &Value) -> bool {
    value.is_null()
        || value.as_str().is_some_and(str::is_empty)
        || value.as_object().is_some_and(Map::is_empty)
        || value.as_array().is_some_and(Vec::is_empty)
}

fn tool_status(value: &Value) -> (bool, &'static str) {
    for key in ["exit_code", "exitCode"] {
        if let Some(code) = value[key].as_i64() {
            return (code != 0, key);
        }
    }
    if let Some(failed) = value["is_error"].as_bool() {
        return (failed, "is_error");
    }
    if let Some(success) = value["success"].as_bool() {
        return (!success, "success");
    }
    if !empty(&value["error"]) && value["error"] != false {
        return (true, "error_field");
    }
    if let Some(stdout) = text(&value["stdout"]) {
        let prefix = stdout
            .chars()
            .take(10)
            .collect::<String>()
            .to_ascii_lowercase();
        if ["error", "fatal", "traceback", "exception"]
            .iter()
            .any(|part| prefix.starts_with(part))
        {
            return (true, "stdout_prefix");
        }
    }
    (false, "default")
}

fn usage(event: &Value) -> Option<Obj> {
    for path in [
        "/usage",
        "/token_usage",
        "/tokenUsage",
        "/data/usage",
        "/data/token_usage",
        "/chunk/usage",
        "/chunk/object/usage",
        "/delta/usage",
        "/stream_chunk/usage",
        "/response/usage",
        "/llm_response/usage",
        "/tool_input/usage",
        "/tool_response/usage",
        "/tool_input/llm_response/usage",
        "/message/usage",
    ] {
        let Some(value) = event.pointer(path).filter(|value| value.is_object()) else {
            continue;
        };
        let i = ["prompt_tokens", "input_tokens", "promptTokens"]
            .into_iter()
            .find_map(|key| value[key].as_u64());
        let o = ["completion_tokens", "output_tokens", "completionTokens"]
            .into_iter()
            .find_map(|key| value[key].as_u64());
        let t = value["total_tokens"]
            .as_u64()
            .or_else(|| value["totalTokens"].as_u64())
            .or_else(|| i.zip(o).and_then(|(i, o)| i.checked_add(o)));
        let c = value["cache_read_input_tokens"]
            .as_u64()
            .or_else(|| value["prompt_tokens_details"]["cached_tokens"].as_u64())
            .filter(|count| i.is_some_and(|input| *count <= input));
        let result: Obj = [
            ("gen_ai.usage.input_tokens", i),
            ("gen_ai.usage.output_tokens", o),
            ("gen_ai.usage.total_tokens", t),
            ("gen_ai.usage.cache_read.input_tokens", c),
        ]
        .into_iter()
        .filter_map(|(key, value)| Some((key.into(), json!(value?))))
        .collect();
        if !result.is_empty() {
            return Some(result);
        }
    }
    if let Some(message) =
        text(&event["message"]).filter(|s| s.len() <= 32_000 && s.trim_start().starts_with('{'))
    {
        let mut nested: Value = serde_json::from_str(message).ok()?;
        if nested["message"].is_string() {
            nested["message"] = Value::Null;
        }
        if let Some(metrics) = usage(&nested) {
            return Some(metrics);
        }
    }
    event["token_count"]
        .as_u64()
        .filter(|count| *count > 0)
        .map(|count| Map::from_iter([("gen_ai.usage.total_tokens".into(), json!(count))]))
}

#[cfg(test)]
mod tests;
