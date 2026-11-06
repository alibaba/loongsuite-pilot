//! Port of `src/inputs/qoder-work/qoder-work-input.ts`.

use crate::inputs::base::{
    build_canonical_hook_entry, hosted_hook, CanonicalHookRecordOptions, HookBody, HookPaths,
    InputRuntime,
};
use crate::normalization::{
    build_agent_activity_entry, enrich_canonical_entry_with_git, to_json_value,
};
use crate::types::{ActionType, AgentActivityEntry, ClientType};
use crate::utils::{directory_exists, resolve_home, DEFAULT_POLL_INTERVAL_MS};
use async_trait::async_trait;
use serde_json::{json, Map, Value};
use std::sync::{Arc, Mutex};

pub struct QoderWorkInput {
    inner: Arc<crate::inputs::base::HostedInput<crate::inputs::base::HookAdapter<QoderWorkBody>>>,
}

struct QoderWorkBody {
    paths: HookPaths,
    agent_type: ClientType,
    id: String,
    last_agent_version: Mutex<String>,
}

pub struct QoderWorkOptions {
    pub state_store: Arc<crate::checkpoints::StateStore>,
    pub log_dir: Option<String>,
    pub log_prefix: Option<String>,
    pub poll_interval_ms: Option<u64>,
    pub agent_type: Option<ClientType>,
}

impl QoderWorkInput {
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

    pub fn new(opts: QoderWorkOptions) -> Self {
        let agent_type = opts.agent_type.unwrap_or(ClientType::QoderWork);
        let log_prefix = opts.log_prefix.unwrap_or_else(|| {
            if agent_type == ClientType::QoderWork {
                "qoder-work".into()
            } else {
                agent_type.as_str().to_owned()
            }
        });
        let default_log_dir = if agent_type == ClientType::QoderWork {
            resolve_home("~/.loongsuite-pilot/logs/qoder-work/history")
        } else {
            resolve_home(&format!(
                "~/.loongsuite-pilot/logs/{}/history",
                agent_type.as_str()
            ))
        };
        let id = format!("{agent_type}-hook");
        Self {
            inner: hosted_hook(
                QoderWorkBody {
                    paths: HookPaths {
                        log_dir: opts.log_dir.unwrap_or(default_log_dir),
                        log_prefix,
                        cold_start_keep_last_turn_only: false,
                    },
                    agent_type,
                    id,
                    last_agent_version: Mutex::new(String::new()),
                },
                "QoderWorkInput",
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

    pub fn id(&self) -> &str {
        self.inner.id()
    }

    pub fn agent_type(&self) -> ClientType {
        self.inner.agent_type()
    }

    pub fn agent_version(&self) -> String {
        self.inner.agent_version()
    }

    pub async fn check_availability() -> bool {
        directory_exists(&resolve_home("~/.qoderwork")).await
    }

    pub fn get_watch_paths() -> Vec<String> {
        vec![resolve_home("~/.qoderwork")]
    }
}

#[async_trait]
impl HookBody for QoderWorkBody {
    fn checkpoint_namespaces(&self) -> Option<Vec<String>> {
        Some(vec![self.id().to_owned()])
    }

    fn id(&self) -> &str {
        &self.id
    }

    fn agent_type(&self) -> ClientType {
        self.agent_type
    }

    fn paths(&self) -> &HookPaths {
        &self.paths
    }

    fn agent_version(&self) -> String {
        self.last_agent_version
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone()
    }

    async fn transform_record(
        &self,
        _rt: &InputRuntime,
        record: &mut Map<String, Value>,
    ) -> anyhow::Result<Option<AgentActivityEntry>> {
        if let Some(Value::String(version)) = record.get("agent.qoderwork.version") {
            if !version.is_empty() {
                *self
                    .last_agent_version
                    .lock()
                    .unwrap_or_else(|err| err.into_inner()) = version.clone();
            }
        }
        record.remove("version");
        if let Some(mut entry) = build_canonical_hook_entry(
            record,
            self.agent_type.as_str(),
            None,
            CanonicalHookRecordOptions::default(),
        ) {
            let _ = enrich_canonical_entry_with_git(&mut entry, record, "qoder-work").await;
            return Ok(Some(entry));
        }
        if let Some(mut entry) = build_post_tool_use_entry(record, self.agent_type) {
            let _ = enrich_canonical_entry_with_git(&mut entry, record, "qoder-work").await;
            return Ok(Some(entry));
        }
        let row_type = record.get("type").and_then(Value::as_str).unwrap_or("");
        if row_type != "assistant" && row_type != "user" {
            return Ok(None);
        }
        let message = record
            .get("message")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .filter(|role| !role.is_empty())
            .unwrap_or(row_type);
        let message_content = message.get("content");
        let part_type;
        let part_text;
        let mut part_thinking = None;
        let mut tool_name = None;
        let mut tool_call_id = None;
        let mut tool_args = None;
        let mut tool_use_id = None;
        let mut tool_result = None;
        if let Some(Value::String(text)) = message_content {
            part_type = Some("text".to_owned());
            part_text = Some(text.clone());
        } else {
            let content0 = message_content
                .and_then(Value::as_array)
                .and_then(|list| list.first())
                .and_then(Value::as_object);
            let Some(content0) = content0 else {
                return Ok(None);
            };
            let Some(kind) = content0.get("type").and_then(Value::as_str) else {
                return Ok(None);
            };
            part_type = Some(kind.to_owned());
            part_text = content0
                .get("text")
                .and_then(Value::as_str)
                .map(str::to_owned);
            part_thinking = content0
                .get("thinking")
                .and_then(Value::as_str)
                .map(str::to_owned);
            tool_name = content0
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_owned);
            tool_call_id = content0
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_owned);
            tool_use_id = content0
                .get("tool_use_id")
                .and_then(Value::as_str)
                .map(str::to_owned);
            tool_args = to_json_value(content0.get("input"));
            tool_result = to_json_value(content0.get("content"));
        }
        let event_name = if part_type.as_deref() == Some("tool_use") {
            "tool.call"
        } else if part_type.as_deref() == Some("tool_result") {
            "tool.result"
        } else if role == "assistant" {
            "llm.response"
        } else {
            "llm.request"
        };
        let timestamp = parse_timestamp(record.get("timestamp")).unwrap_or_else(now_ms);
        let mut standard = Map::new();
        if event_name == "llm.request" {
            if let Some(text) = &part_text {
                standard.insert(
                    "gen_ai.input.messages_delta".into(),
                    json!([{ "role": "user", "parts": [{ "type": "text", "content": text }] }]),
                );
            }
        } else if event_name == "llm.response" {
            let mut parts = Vec::new();
            if part_type.as_deref() == Some("thinking") {
                if let Some(thinking) = &part_thinking {
                    parts.push(json!({ "type": "reasoning", "content": thinking }));
                }
            } else if let Some(text) = &part_text {
                parts.push(json!({ "type": "text", "content": text }));
            }
            if !parts.is_empty() {
                let mut msg = json!({ "role": "assistant", "parts": parts });
                if let Some(stop) = message
                    .get("stop_reason")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                {
                    msg.as_object_mut()
                        .unwrap()
                        .insert("finish_reason".into(), Value::String(stop.to_owned()));
                    standard.insert("gen_ai.response.finish_reasons".into(), json!([stop]));
                }
                standard.insert("gen_ai.output.messages".into(), Value::Array(vec![msg]));
            } else if let Some(stop) = message
                .get("stop_reason")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                standard.insert("gen_ai.response.finish_reasons".into(), json!([stop]));
            }
            if let Some(id) = message
                .get("id")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                standard.insert("gen_ai.response.id".into(), Value::String(id.to_owned()));
            }
        } else if event_name == "tool.call" {
            if let Some(name) = &tool_name {
                standard.insert("gen_ai.tool.name".into(), Value::String(name.clone()));
            }
            if let Some(id) = &tool_call_id {
                standard.insert("gen_ai.tool.call.id".into(), Value::String(id.clone()));
            }
            if let Some(args) = tool_args.clone() {
                standard.insert("gen_ai.tool.call.arguments".into(), args);
            }
        } else if event_name == "tool.result" {
            if let Some(id) = &tool_use_id {
                standard.insert("gen_ai.tool.call.id".into(), Value::String(id.clone()));
            }
            if let Some(result) = tool_result.clone() {
                standard.insert("gen_ai.tool.call.result".into(), result);
            }
        }
        let mut attributes = Map::new();
        copy_str(record, "cwd", &mut attributes, "cwd");
        copy_str(record, "parentUuid", &mut attributes, "parent_uuid");
        copy_str(record, "userType", &mut attributes, "user_type");
        copy_str(record, "entrypoint", &mut attributes, "entrypoint");
        if !row_type.is_empty() {
            attributes.insert("row_type".into(), Value::String(row_type.to_owned()));
        }
        if let Some(kind) = &part_type {
            attributes.insert("_ctype".into(), Value::String(kind.clone()));
        }
        if let Some(name) = &tool_name {
            attributes.insert("_cname".into(), Value::String(name.clone()));
        }
        if let Some(args) = tool_args {
            attributes.insert("_cinput".into(), args);
        }
        if let Some(text) = &part_text {
            attributes.insert("_ctext".into(), Value::String(text.clone()));
        }
        if let Some(result) = tool_result {
            attributes.insert("_ccontent".into(), result);
        }
        if let Some(thinking) = &part_thinking {
            attributes.insert("_cthinking".into(), Value::String(thinking.clone()));
        }
        if let Some(id) = &tool_call_id {
            attributes.insert("_cid".into(), Value::String(id.clone()));
        }
        if let Some(id) = &tool_use_id {
            attributes.insert("_ctool_use_id".into(), Value::String(id.clone()));
        }
        let mut opts = standard;
        opts.insert("timestamp".into(), json!(timestamp));
        opts.insert(
            "session.id".into(),
            Value::String(
                first_str(record, &["session_id", "sessionId", "sessionid"]).unwrap_or_default(),
            ),
        );
        opts.insert(
            "user.id".into(),
            Value::String(first_str(record, &["user_id", "userId"]).unwrap_or_default()),
        );
        opts.insert(
            "agent.type".into(),
            Value::String(self.agent_type.as_str().to_owned()),
        );
        opts.insert("event.name".into(), Value::String(event_name.to_owned()));
        opts.insert("attributes".into(), Value::Object(attributes));
        let mut entry = build_agent_activity_entry(&Value::Object(opts));
        if let Some(uuid) = record.get("uuid").and_then(Value::as_str) {
            if !uuid.trim().is_empty() {
                entry.event_id = uuid.to_owned();
                entry
                    .extra
                    .insert("uuid".into(), Value::String(uuid.to_owned()));
            }
        }
        let _ = enrich_canonical_entry_with_git(&mut entry, record, "qoder-work").await;
        Ok(Some(entry))
    }
}

fn build_post_tool_use_entry(
    record: &Map<String, Value>,
    agent_type: ClientType,
) -> Option<AgentActivityEntry> {
    let data = record
        .get("data")
        .and_then(Value::as_object)
        .unwrap_or(record);
    let event_type = data
        .get("event_type")
        .or_else(|| data.get("hook_event_name"))
        .or_else(|| record.get("hookEvent"))
        .and_then(Value::as_str)?;
    if event_type != "PostToolUse" {
        return None;
    }
    let tool_input = data.get("tool_input").and_then(Value::as_object);
    let file_path = tool_input
        .and_then(|input| input.get("file_path"))
        .and_then(Value::as_str)
        .or_else(|| data.get("file_path").and_then(Value::as_str))
        .unwrap_or("");
    if file_path.is_empty() {
        return None;
    }
    let content = tool_input
        .and_then(|input| input.get("content"))
        .and_then(Value::as_str)
        .or_else(|| {
            tool_input
                .and_then(|input| input.get("new_string"))
                .and_then(Value::as_str)
        });
    let action = if data.get("loongsuite_pilot_pre_file_exists") == Some(&Value::Bool(false)) {
        ActionType::Create
    } else {
        ActionType::Edit
    };
    let mut opts = Map::new();
    opts.insert(
        "sessionId".into(),
        json!(data.get("session_id").and_then(Value::as_str).unwrap_or("")),
    );
    opts.insert(
        "userId".into(),
        json!(data.get("user_id").and_then(Value::as_str).unwrap_or("")),
    );
    opts.insert("agentType".into(), json!(agent_type.as_str()));
    opts.insert("actionType".into(), json!(action.as_str()));
    opts.insert("filePath".into(), json!(file_path));
    if let Some(content) = content {
        opts.insert("content".into(), json!(content));
    }
    opts.insert(
        "timestamp".into(),
        json!(parse_timestamp(data.get("timestamp")).unwrap_or_else(now_ms)),
    );
    opts.insert("extra".into(), Value::Object(data.clone()));
    Some(build_agent_activity_entry(&Value::Object(opts)))
}

fn parse_timestamp(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Number(number) => number
            .as_i64()
            .or_else(|| number.as_f64().map(|n| n as i64)),
        Value::String(text) => text
            .parse::<f64>()
            .ok()
            .filter(|n| n.is_finite())
            .map(|n| n as i64)
            .or_else(|| {
                chrono::DateTime::parse_from_rfc3339(text)
                    .ok()
                    .map(|time| time.timestamp_millis())
            }),
        _ => None,
    }
}

fn copy_str(
    record: &Map<String, Value>,
    from: &str,
    attributes: &mut Map<String, Value>,
    to: &str,
) {
    if let Some(value) = record
        .get(from)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        attributes.insert(to.to_owned(), Value::String(value.to_owned()));
    }
}

fn first_str(record: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| record.get(*key).and_then(Value::as_str).map(str::to_owned))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
#[path = "hook_history_migration_contract_tests.rs"]
mod work_hook_history_migration_contract_tests;
