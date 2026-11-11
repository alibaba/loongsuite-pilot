//! Port of `src/inputs/qoder-work-log/qoder-work-log-input.ts`.
//!
//! Line parsing matches the TypeScript regexes. Turn close emits one
//! `llm.response` plus one `tool.call` per `tool_use` block. Argument text is
//! not reconstructed from `input_json_delta`, matching the source comment that
//! SDK write order is not token order.

use crate::inputs::base::{InputBody, InputRuntime, SessionPaths};
use crate::normalization::build_agent_activity_entry;
use crate::types::{AgentActivityEntry, ClientType};
use crate::utils::{directory_exists, resolve_home, DEFAULT_POLL_INTERVAL_MS};
use async_trait::async_trait;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

static RECEIVED_MSG_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\[([^\]]+)\] \[(\w+)\] \[SDK\] \[QueryHandler\] Received message: (\w+) (.+)$")
        .expect("sdk received")
});
static SET_MODEL_POLICY_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\[([^\]]+)\] \[(\w+)\] \[SDK\] \[QueryHandler\] Sending control request: set_model_policy (.+)$")
        .expect("sdk policy")
});

#[derive(Debug, Clone, PartialEq)]
pub enum SdkEvent {
    SystemInit {
        ts: i64,
        session_id: String,
        subscription_tier: String,
        cwd: String,
        agents: Vec<String>,
        tools: Vec<String>,
    },
    SetModelPolicy {
        ts: i64,
        chat_model: String,
        compact_model: String,
        scene_model: String,
    },
    MessageStart {
        ts: i64,
        session_id: String,
        message_id: String,
    },
    BlockStart {
        ts: i64,
        session_id: String,
        block_type: String,
        index: i64,
        tool_name: Option<String>,
        tool_id: Option<String>,
    },
    Delta {
        ts: i64,
        session_id: String,
        delta_type: String,
        content: String,
        block_index: Option<i64>,
    },
    MessageDelta {
        ts: i64,
        session_id: String,
        stop_reason: String,
        input_tokens: i64,
        output_tokens: i64,
    },
    MessageStop {
        ts: i64,
        session_id: String,
    },
    Result {
        ts: i64,
        session_id: String,
        result_id: String,
        subtype: String,
        duration_ms: f64,
        duration_api_ms: f64,
        num_turns: f64,
        context_usage_ratio: f64,
    },
    PostToolUse {
        ts: i64,
        session_id: String,
        tool_use_id: String,
        tool_name: String,
        tool_response: String,
        transcript_path: String,
    },
}

pub fn resolve_qoder_work_root(variant: &str) -> String {
    let cn = variant == "cn";
    if cfg!(target_os = "macos") {
        return resolve_home(if cn {
            "~/Library/Application Support/QoderWork CN"
        } else {
            "~/Library/Application Support/QoderWork"
        });
    }
    let dir_name = if cn { "QoderWork CN" } else { "QoderWork" };
    if cfg!(windows) {
        let appdata = std::env::var("APPDATA").unwrap_or_else(|_| {
            PathBuf::from(resolve_home("~"))
                .join("AppData")
                .join("Roaming")
                .to_string_lossy()
                .into_owned()
        });
        return PathBuf::from(appdata)
            .join(dir_name)
            .to_string_lossy()
            .into_owned();
    }
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        if !xdg.is_empty() {
            return PathBuf::from(xdg)
                .join(dir_name)
                .to_string_lossy()
                .into_owned();
        }
    }
    resolve_home(if cn {
        "~/.config/QoderWork CN"
    } else {
        "~/.config/QoderWork"
    })
}

pub fn parse_sdk_log_line(line: &str) -> Option<SdkEvent> {
    if let Some(caps) = SET_MODEL_POLICY_RE.captures(line) {
        let ts = parse_ts(caps.get(1).map(|m| m.as_str()).unwrap_or(""));
        let envelope: Value =
            serde_json::from_str(caps.get(3).map(|m| m.as_str()).unwrap_or("")).ok()?;
        let inner = envelope
            .pointer("/request/request")
            .cloned()
            .unwrap_or(Value::Null);
        return Some(SdkEvent::SetModelPolicy {
            ts,
            chat_model: extract_model(inner.get("chat")),
            compact_model: extract_model(inner.get("compact")),
            scene_model: extract_model(inner.get("scene_model")),
        });
    }
    let caps = RECEIVED_MSG_RE.captures(line)?;
    let ts = parse_ts(caps.get(1).map(|m| m.as_str()).unwrap_or(""));
    let msg_type = caps.get(3).map(|m| m.as_str()).unwrap_or("");
    let data: Value = serde_json::from_str(caps.get(4).map(|m| m.as_str()).unwrap_or("")).ok()?;
    if msg_type == "system"
        && (data.get("subtype").and_then(Value::as_str) == Some("init")
            || data.get("type").and_then(Value::as_str) == Some("init"))
    {
        return Some(SdkEvent::SystemInit {
            ts,
            session_id: string_or(data.get("session_id")),
            subscription_tier: string_or(data.get("model")),
            cwd: string_or(data.get("cwd")),
            agents: array_of_string(data.get("agents")),
            tools: array_of_string(data.get("tools")),
        });
    }
    if msg_type == "stream_event" {
        return parse_stream_event(ts, &string_or(data.get("session_id")), data.get("event")?);
    }
    if msg_type == "result" {
        return Some(SdkEvent::Result {
            ts,
            session_id: string_or(data.get("session_id")),
            result_id: string_or(data.get("uuid")),
            subtype: string_or(data.get("subtype")),
            duration_ms: number_or(data.get("duration_ms")),
            duration_api_ms: number_or(data.get("duration_api_ms")),
            num_turns: number_or(data.get("num_turns")),
            context_usage_ratio: number_or(data.get("context_usage_ratio")),
        });
    }
    if msg_type == "control_request" {
        let input = data.pointer("/request/input")?;
        if input.get("hook_event_name").and_then(Value::as_str) == Some("PostToolUse") {
            return Some(SdkEvent::PostToolUse {
                ts,
                session_id: string_or(input.get("session_id")),
                tool_use_id: string_or(input.get("tool_use_id")),
                tool_name: string_or(input.get("tool_name")),
                tool_response: string_or(input.get("tool_response")),
                transcript_path: string_or(input.get("transcript_path")),
            });
        }
    }
    None
}

fn parse_stream_event(ts: i64, session_id: &str, event: &Value) -> Option<SdkEvent> {
    let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
    match kind {
        "message_start" => Some(SdkEvent::MessageStart {
            ts,
            session_id: session_id.to_owned(),
            message_id: string_or(event.pointer("/message/id")),
        }),
        "content_block_start" => {
            let block = event.get("content_block")?;
            let block_type = string_or(block.get("type"));
            if block_type == "thinking" || block_type == "text" || block_type == "tool_use" {
                Some(SdkEvent::BlockStart {
                    ts,
                    session_id: session_id.to_owned(),
                    block_type,
                    index: number_or(event.get("index")) as i64,
                    tool_name: block.get("name").and_then(Value::as_str).map(str::to_owned),
                    tool_id: block.get("id").and_then(Value::as_str).map(str::to_owned),
                })
            } else {
                None
            }
        }
        "content_block_delta" => {
            let delta = event.get("delta")?;
            let delta_type = string_or(delta.get("type"));
            let (content, block_index) = match delta_type.as_str() {
                "thinking_delta" => (string_or(delta.get("thinking")), None),
                "text_delta" => (string_or(delta.get("text")), None),
                "input_json_delta" => (
                    string_or(delta.get("partial_json")),
                    Some(number_or(event.get("index")) as i64),
                ),
                _ => return None,
            };
            Some(SdkEvent::Delta {
                ts,
                session_id: session_id.to_owned(),
                delta_type,
                content,
                block_index,
            })
        }
        "message_delta" => Some(SdkEvent::MessageDelta {
            ts,
            session_id: session_id.to_owned(),
            stop_reason: string_or(event.pointer("/delta/stop_reason")),
            input_tokens: number_or(event.pointer("/usage/input_tokens")) as i64,
            output_tokens: number_or(event.pointer("/usage/output_tokens")) as i64,
        }),
        "message_stop" => Some(SdkEvent::MessageStop {
            ts,
            session_id: session_id.to_owned(),
        }),
        _ => None,
    }
}

pub struct QoderWorkLogOptions {
    pub state_store: std::sync::Arc<crate::checkpoints::StateStore>,
    pub data_root: Option<String>,
    pub agent_type: Option<ClientType>,
    pub poll_interval_ms: Option<u64>,
}

pub struct QoderWorkLogInput {
    inner: std::sync::Arc<crate::inputs::base::HostedInput<QoderWorkLogBody>>,
}

struct QoderWorkLogBody {
    id: String,
    agent_type: ClientType,
    paths: SessionPaths,
    state: Mutex<LogState>,
}

struct LogState {
    sessions: HashMap<String, SessionMeta>,
    turns: HashMap<String, ActiveTurn>,
    policy: ModelPolicy,
}

struct SessionMeta {
    tier: String,
    cwd: String,
    agents: Vec<String>,
    tools: Vec<String>,
}

struct ActiveTurn {
    message_id: String,
    model: String,
    tools: Vec<(String, String)>,
    stop_reason: String,
    input_tokens: i64,
    output_tokens: i64,
    start_ts: i64,
}

#[derive(Default)]
struct ModelPolicy {
    chat: String,
    compact: String,
    scene: String,
}

impl QoderWorkLogInput {
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

    pub fn new(opts: QoderWorkLogOptions) -> Self {
        let agent_type = opts.agent_type.unwrap_or(ClientType::QoderWork);
        let data_root = opts.data_root.unwrap_or_else(|| {
            resolve_qoder_work_root(if agent_type == ClientType::QoderWorkCN {
                "cn"
            } else {
                "standard"
            })
        });
        Self {
            inner: crate::inputs::base::HostedInput::new(
                QoderWorkLogBody {
                    id: format!("{agent_type}-log"),
                    agent_type,
                    paths: SessionPaths {
                        session_dir: PathBuf::from(&data_root)
                            .join("logs")
                            .to_string_lossy()
                            .into_owned(),
                        file_pattern: "sdk-*.log".into(),
                    },
                    state: Mutex::new(LogState {
                        sessions: HashMap::new(),
                        turns: HashMap::new(),
                        policy: ModelPolicy::default(),
                    }),
                },
                "QoderWorkLogInput",
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

    pub fn get_watch_paths() -> Vec<String> {
        vec![PathBuf::from(resolve_qoder_work_root("standard"))
            .join("logs")
            .to_string_lossy()
            .into_owned()]
    }

    pub async fn check_availability() -> bool {
        directory_exists(
            &PathBuf::from(resolve_qoder_work_root("standard"))
                .join("logs")
                .to_string_lossy(),
        )
        .await
    }
}

#[async_trait]
impl InputBody for QoderWorkLogBody {
    fn checkpoint_namespaces(&self) -> Option<Vec<String>> {
        Some(vec![self.id().to_owned()])
    }

    fn id(&self) -> &str {
        &self.id
    }
    fn agent_type(&self) -> ClientType {
        self.agent_type
    }
    fn collection_method(&self) -> crate::types::CollectionMethod {
        crate::types::CollectionMethod::SessionFilePolling
    }

    async fn on_start(&self, rt: &InputRuntime) -> anyhow::Result<()> {
        for file_path in self.discover().await {
            let Ok((mut file, identity)) = open_log_file(&file_path).await else {
                continue;
            };
            let state_key = format!("{}:{file_path}", self.id);
            if rt.state_store.get(&state_key).last_offset().is_some() {
                continue;
            }
            let baseline = find_last_result_boundary(&mut file, identity.size).await;
            rt.state_store.set_offset(&state_key, baseline);
            rt.state_store.update(
                &state_key,
                crate::checkpoints::InputStatePatch {
                    extra: Some(json!({ "inode": identity.ino, "dev": identity.dev, "skippingLine": false })),
                    ..crate::checkpoints::InputStatePatch::default()
                },
            );
        }
        Ok(())
    }

    async fn collect(&self, rt: &InputRuntime) -> anyhow::Result<Vec<AgentActivityEntry>> {
        let mut all = Vec::new();
        for file_path in self.discover().await {
            match self.process_log_file(rt, &file_path).await {
                Ok(entries) => all.extend(entries),
                Err(err) => {
                    let io_err =
                        std::io::Error::new(std::io::ErrorKind::PermissionDenied, err.to_string());
                    if err.to_string().contains("permission")
                        || InputRuntime::is_unreadable_error(&io_err)
                    {
                        rt.diagnose_unreadable_path(&file_path, "event file").await;
                        continue;
                    }
                    return Err(err);
                }
            }
        }
        Ok(all)
    }
}

impl QoderWorkLogBody {
    async fn discover(&self) -> Vec<String> {
        let mut files = Vec::new();
        let Ok(mut dir) = tokio::fs::read_dir(&self.paths.session_dir).await else {
            return files;
        };
        while let Ok(Some(entry)) = dir.next_entry().await {
            if !entry
                .file_type()
                .await
                .map(|kind| kind.is_dir())
                .unwrap_or(false)
            {
                continue;
            }
            let main_log = entry.path().join("main.log");
            if tokio::fs::metadata(&main_log)
                .await
                .map(|meta| meta.is_file())
                .unwrap_or(false)
            {
                files.push(main_log.to_string_lossy().into_owned());
                continue;
            }
            let main_dir = entry.path().join("main");
            let Ok(mut nested) = tokio::fs::read_dir(&main_dir).await else {
                continue;
            };
            while let Ok(Some(log)) = nested.next_entry().await {
                let name = log.file_name().to_string_lossy().into_owned();
                if name.starts_with("sdk-") && name.ends_with(".log") {
                    files.push(log.path().to_string_lossy().into_owned());
                }
            }
        }
        files.sort();
        files
    }

    async fn process_log_file(
        &self,
        rt: &InputRuntime,
        file_path: &str,
    ) -> anyhow::Result<Vec<AgentActivityEntry>> {
        let (file, identity) = open_log_file(file_path).await?;
        self.process_opened_log_file(rt, file_path, file, identity)
            .await
    }

    async fn process_opened_log_file(
        &self,
        rt: &InputRuntime,
        file_path: &str,
        mut file: tokio::fs::File,
        identity: crate::utils::file_identity::OpenedFileIdentity,
    ) -> anyhow::Result<Vec<AgentActivityEntry>> {
        let state_key = format!("{}:{file_path}", self.id);
        let inode = identity.ino;
        let prev = rt.state_store.get(&state_key);
        let prev_inode = prev
            .extra()
            .and_then(|extra| extra.get("inode").and_then(Value::as_u64));
        let prev_dev = prev
            .extra()
            .and_then(|extra| extra.get("dev").and_then(Value::as_u64));
        let saved_offset = prev.last_offset().unwrap_or(0.0).max(0.0) as u64;
        let reset = (prev_inode.is_some() && prev_inode != Some(inode))
            || (prev_dev.is_some() && prev_dev != Some(identity.dev))
            || saved_offset > identity.size;
        let offset = if reset { 0 } else { saved_offset };
        if reset {
            self.state.lock().unwrap_or_else(|e| e.into_inner()).policy = ModelPolicy::default();
        }
        let skipping = !reset && prev.extra().is_some_and(|v| v["skippingLine"] == true);
        let batch = super::bounded_line_tail::read_line_tail(
            &mut file,
            identity.size,
            offset,
            skipping,
            rt,
        )
        .await?;
        if batch.began_skip {
            rt.warn(
                "oversized Qoder Work SDK line skipped",
                json!({"path":file_path,"offset":offset}).as_object(),
            );
        }
        if reset
            || prev_inode != Some(inode)
            || prev_dev != Some(identity.dev)
            || batch.offset != saved_offset
            || batch.skipping_line != skipping
        {
            rt.state_store.update(&state_key, crate::checkpoints::InputStatePatch {
                last_offset: Some(batch.offset as f64),
                extra: Some(json!({"inode":inode,"dev":identity.dev,"skippingLine":batch.skipping_line})),
                ..Default::default()
            });
        }
        let bytes = batch.bytes;
        let text = String::from_utf8_lossy(&bytes);
        let mut out = Vec::new();
        for line in text.split('\n') {
            if line.trim().is_empty() {
                continue;
            }
            let Some(event) = parse_sdk_log_line(line) else {
                continue;
            };
            out.extend(self.apply_event(event));
        }
        Ok(out)
    }
}

impl QoderWorkLogBody {
    fn apply_event(&self, event: SdkEvent) -> Vec<AgentActivityEntry> {
        let mut state = self.state.lock().unwrap_or_else(|err| err.into_inner());
        match event {
            SdkEvent::SystemInit {
                session_id,
                subscription_tier,
                cwd,
                agents,
                tools,
                ..
            } => {
                state.sessions.insert(
                    session_id,
                    SessionMeta {
                        tier: subscription_tier,
                        cwd,
                        agents,
                        tools,
                    },
                );
                Vec::new()
            }
            SdkEvent::SetModelPolicy {
                chat_model,
                compact_model,
                scene_model,
                ..
            } => {
                state.policy.chat = chat_model;
                state.policy.compact = compact_model;
                state.policy.scene = scene_model;
                Vec::new()
            }
            SdkEvent::MessageStart {
                ts,
                session_id,
                message_id,
            } => {
                let model = model_for_tier(
                    &state.policy,
                    state
                        .sessions
                        .get(&session_id)
                        .map(|s| s.tier.as_str())
                        .unwrap_or(""),
                );
                state.turns.insert(
                    session_id,
                    ActiveTurn {
                        message_id,
                        model,
                        tools: Vec::new(),
                        stop_reason: String::new(),
                        input_tokens: 0,
                        output_tokens: 0,
                        start_ts: ts,
                    },
                );
                Vec::new()
            }
            SdkEvent::BlockStart {
                session_id,
                block_type,
                tool_name,
                tool_id,
                ..
            } if block_type == "tool_use" => {
                if let Some(turn) = state.turns.get_mut(&session_id) {
                    turn.tools
                        .push((tool_id.unwrap_or_default(), tool_name.unwrap_or_default()));
                }
                Vec::new()
            }
            SdkEvent::MessageDelta {
                session_id,
                stop_reason,
                input_tokens,
                output_tokens,
                ..
            } => {
                if let Some(turn) = state.turns.get_mut(&session_id) {
                    turn.stop_reason = stop_reason;
                    turn.input_tokens = input_tokens;
                    turn.output_tokens = output_tokens;
                }
                Vec::new()
            }
            SdkEvent::MessageStop { ts, session_id } => {
                let Some(turn) = state.turns.remove(&session_id) else {
                    return Vec::new();
                };
                let session = state.sessions.get(&session_id);
                let mut opts = serde_json::Map::new();
                opts.insert("timestamp".into(), json!(ts));
                opts.insert("event.name".into(), json!("llm.response"));
                opts.insert("gen_ai.session.id".into(), json!(session_id));
                opts.insert("gen_ai.agent.type".into(), json!(self.agent_type.as_str()));
                opts.insert("gen_ai.request.model".into(), json!(turn.model));
                opts.insert("gen_ai.response.model".into(), json!(turn.model));
                opts.insert("gen_ai.response.id".into(), json!(turn.message_id));
                if !turn.stop_reason.is_empty() {
                    opts.insert(
                        "gen_ai.response.finish_reasons".into(),
                        json!([turn.stop_reason]),
                    );
                }
                if turn.input_tokens > 0 {
                    opts.insert("gen_ai.usage.input_tokens".into(), json!(turn.input_tokens));
                }
                if turn.output_tokens > 0 {
                    opts.insert(
                        "gen_ai.usage.output_tokens".into(),
                        json!(turn.output_tokens),
                    );
                }
                if turn.input_tokens > 0 || turn.output_tokens > 0 {
                    opts.insert(
                        "gen_ai.usage.total_tokens".into(),
                        json!(turn.input_tokens.saturating_add(turn.output_tokens)),
                    );
                }
                let mut attributes = serde_json::Map::new();
                if let Some(session) = session {
                    if !session.tier.is_empty() {
                        attributes.insert("subscription_tier".into(), json!(session.tier));
                    }
                    if !session.cwd.is_empty() {
                        attributes.insert("cwd".into(), json!(session.cwd));
                    }
                    if !session.agents.is_empty() {
                        attributes.insert("agents".into(), json!(session.agents));
                    }
                    if !session.tools.is_empty() {
                        attributes.insert("tools".into(), json!(session.tools));
                    }
                }
                attributes.insert("message_id".into(), json!(turn.message_id));
                let shared = attributes.clone();
                attributes.insert("source".into(), json!("qoder-work-sdk-log"));
                attributes.insert("event_kind".into(), json!("response"));
                attributes.insert("tool_use_count".into(), json!(turn.tools.len()));
                opts.insert("attributes".into(), Value::Object(attributes));
                let mut entries = vec![build_agent_activity_entry(&Value::Object(opts))];
                for (index, (call_id, tool_name)) in turn.tools.iter().enumerate() {
                    let mut attributes = shared.clone();
                    attributes.insert("source".into(), json!("qoder-work-sdk-log"));
                    attributes.insert("event_kind".into(), json!("tool_use"));
                    attributes.insert("tool_index".into(), json!(index));
                    entries.push(build_agent_activity_entry(&json!({
                        "timestamp":ts,"event.name":"tool.call",
                        "gen_ai.session.id":session_id,"gen_ai.agent.type":self.agent_type.as_str(),
                        "gen_ai.request.model":turn.model,"gen_ai.response.model":turn.model,
                        "gen_ai.response.id":turn.message_id,"gen_ai.tool.name":tool_name,
                        "gen_ai.tool.call.id":call_id,"gen_ai.tool.call.exec.id":call_id,
                        "attributes":attributes,
                    })));
                }
                let _ = turn.start_ts;
                entries
            }
            SdkEvent::Result {
                ts,
                session_id,
                result_id,
                subtype,
                duration_ms,
                duration_api_ms,
                num_turns,
                context_usage_ratio,
            } => {
                let session = state.sessions.get(&session_id);
                let model = model_for_tier(
                    &state.policy,
                    session.map(|s| s.tier.as_str()).unwrap_or(""),
                );
                let mut attributes = serde_json::Map::from_iter([
                    ("source".into(), json!("qoder-work-sdk-log")),
                    ("event_kind".into(), json!("result")),
                    ("subtype".into(), json!(subtype)),
                    ("result_subtype".into(), json!(subtype)),
                    ("duration_ms".into(), json!(duration_ms)),
                    ("duration_api_ms".into(), json!(duration_api_ms)),
                    ("num_turns".into(), json!(num_turns)),
                    ("context_usage_ratio".into(), json!(context_usage_ratio)),
                ]);
                if let Some(session) = session {
                    if !session.tier.is_empty() {
                        attributes.insert("subscription_tier".into(), json!(session.tier));
                    }
                    if !session.cwd.is_empty() {
                        attributes.insert("cwd".into(), json!(session.cwd));
                    }
                    if !session.agents.is_empty() {
                        attributes.insert("agents".into(), json!(session.agents));
                    }
                    if !session.tools.is_empty() {
                        attributes.insert("tools".into(), json!(session.tools));
                    }
                }
                vec![build_agent_activity_entry(&json!({
                    "timestamp":ts,"event.name":"other","event.id":result_id,
                    "gen_ai.session.id":session_id,"gen_ai.agent.type":self.agent_type.as_str(),
                    "gen_ai.request.model":model,"gen_ai.response.model":model,"attributes":attributes,
                }))]
            }
            _ => Vec::new(),
        }
    }
}

async fn find_last_result_boundary(file: &mut tokio::fs::File, size: u64) -> f64 {
    if size == 0 {
        return 0.0;
    }
    if file.seek(std::io::SeekFrom::Start(0)).await.is_err() {
        return 0.0;
    }
    let mut bytes = Vec::new();
    if file.take(size).read_to_end(&mut bytes).await.is_err() {
        return 0.0;
    }
    let text = String::from_utf8_lossy(&bytes);
    let mut offset = 0_usize;
    let mut boundary = 0_usize;
    for line in text.split('\n') {
        let next = offset + line.len() + 1;
        if line.contains("Received message: result ") {
            boundary = next.min(bytes.len());
        }
        offset = next;
    }
    boundary as f64
}

pub(crate) async fn open_log_file(
    path: &str,
) -> std::io::Result<(
    tokio::fs::File,
    crate::utils::file_identity::OpenedFileIdentity,
)> {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || {
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NONBLOCK);
        }
        let file = options.open(path)?;
        let identity = crate::utils::file_identity::identity_from_open(&file)?;
        Ok((tokio::fs::File::from_std(file), identity))
    })
    .await
    .map_err(std::io::Error::other)?
}

fn model_for_tier(policy: &ModelPolicy, tier: &str) -> String {
    let chosen = if tier.eq_ignore_ascii_case("standard") && !policy.scene.is_empty() {
        policy.scene.clone()
    } else if !policy.chat.is_empty() {
        policy.chat.clone()
    } else {
        policy.scene.clone()
    };
    if chosen.is_empty() {
        "unknown".into()
    } else {
        chosen
    }
}

fn parse_ts(text: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(text)
        .map(|time| time.timestamp_millis())
        .ok()
        .or_else(|| {
            use chrono::TimeZone;
            let naive = chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S%.f").ok()?;
            chrono::Local
                .from_local_datetime(&naive)
                .earliest()
                .map(|time| time.timestamp_millis())
        })
        .unwrap_or_else(now_ms)
}

fn string_or(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).unwrap_or("").to_owned()
}

fn number_or(value: Option<&Value>) -> f64 {
    value
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite())
        .unwrap_or(0.0)
}

fn array_of_string(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn extract_model(value: Option<&Value>) -> String {
    value
        .and_then(|value| value.get("model"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
#[path = "log_identity_tests.rs"]
mod log_identity_tests;

#[cfg(test)]
#[path = "sdk_history_migration_contract_tests.rs"]
mod work_sdk_history_migration_contract_tests;
