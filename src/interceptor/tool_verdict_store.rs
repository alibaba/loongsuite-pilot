//! Tool-phase verdicts. The checkpoint is pretty JSON, schema 1.
//!
//! ```text
//! {
//!   "schema": 1,
//!   "records": [ { "sessionId"?, "toolUseId", "phase", "action", "recordedAt" } ]
//! }
//! ```

use super::prompt_verdict::{is_qoder, valid_digest, PromptKey, PromptLookup, MATCH_WINDOW_MS};
use crate::interceptor::types::HookEventName;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

pub const TOOL_VERDICT_TTL_MS: i64 = 30 * 60 * 1000;
pub const TOOL_VERDICT_CHECKPOINT_INTERVAL_MS: u64 = 15_000;
const TOOL_VERDICT_MAX_RECORDS: usize = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ToolVerdictAction {
    #[serde(rename = "allow")]
    Allow,
    #[serde(rename = "block")]
    Block,
    #[serde(rename = "log")]
    Log,
}

impl ToolVerdictAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Block => "block",
            Self::Log => "log",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "allow" => Some(Self::Allow),
            "block" => Some(Self::Block),
            "log" => Some(Self::Log),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ToolInterceptPhase {
    #[serde(rename = "PreToolUse")]
    PreToolUse,
    #[serde(rename = "PostToolUse")]
    PostToolUse,
}

impl ToolInterceptPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PreToolUse => "PreToolUse",
            Self::PostToolUse => "PostToolUse",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "PreToolUse" => Some(Self::PreToolUse),
            "PostToolUse" => Some(Self::PostToolUse),
            _ => None,
        }
    }
}

pub fn is_tool_intercept_phase(event: HookEventName) -> Option<ToolInterceptPhase> {
    match event {
        HookEventName::PreToolUse => Some(ToolInterceptPhase::PreToolUse),
        HookEventName::PostToolUse => Some(ToolInterceptPhase::PostToolUse),
        HookEventName::UserPromptSubmit => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolVerdictKey {
    pub session_id: Option<String>,
    pub tool_use_id: String,
    pub phase: ToolInterceptPhase,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuardrailMetadata {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    action: Option<crate::types::GuardrailAction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    rule_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    rule_version: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    fail_open: bool,
}

impl GuardrailMetadata {
    pub(crate) fn from_verdict(verdict: &Value) -> Self {
        use crate::types::GuardrailAction;
        let action = if verdict["action"] == "block" {
            GuardrailAction::Block
        } else if verdict["matched"] == true {
            GuardrailAction::Log
        } else {
            GuardrailAction::Allow
        };
        Self {
            action: Some(action),
            fail_open: verdict["failOpen"] == true,
            rule_id: verdict["ruleId"].as_str().map(str::to_owned),
            rule_version: verdict["ruleVersion"].as_str().map(str::to_owned),
        }
    }

    pub(crate) fn tool_action(&self) -> ToolVerdictAction {
        match self.action {
            Some(crate::types::GuardrailAction::Block) => ToolVerdictAction::Block,
            Some(crate::types::GuardrailAction::Log) => ToolVerdictAction::Log,
            _ => ToolVerdictAction::Allow,
        }
    }

    pub fn apply(&self, entry: &mut crate::types::AgentActivityEntry) {
        if let Some(action) = self.action {
            entry.guardrail_triggered = Some(true);
            entry.guardrail_action = Some(action);
        }
        if self.fail_open {
            entry
                .extra
                .insert("gen_ai.guardrail.fail_open".into(), Value::Bool(true));
        }
        if entry.guardrail_action == Some(crate::types::GuardrailAction::Allow) {
            return;
        }
        if let Some(rule_id) = self.rule_id.as_ref().filter(|id| !id.is_empty()) {
            entry
                .extra
                .insert("gen_ai.guardrail.rule_id".into(), rule_id.clone().into());
        }
        if let Some(version) = &self.rule_version {
            entry.extra.insert(
                "gen_ai.guardrail.rule_version".into(),
                version.clone().into(),
            );
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct ToolVerdictRecordOut {
    #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(rename = "toolUseId")]
    tool_use_id: String,
    phase: ToolInterceptPhase,
    action: ToolVerdictAction,
    #[serde(flatten)]
    metadata: VerdictDetails,
    #[serde(rename = "recordedAt")]
    recorded_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct VerdictDetails {
    #[serde(skip_serializing_if = "Option::is_none")]
    rule_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rule_version: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    fail_open: bool,
}

#[derive(Clone)]
struct StoredVerdict {
    action: ToolVerdictAction,
    guardrail: Option<GuardrailMetadata>,
    recorded_at_ms: i64,
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PromptBinding {
    request_id: String,
    agent_type: String,
    at: i64,
}

impl PromptBinding {
    fn matches(&self, request_id: &str, agent_type: &str) -> bool {
        self.request_id == request_id && self.agent_type == agent_type
    }
}

struct StoredPrompt {
    recorded_at: i64,
    guardrail: Option<GuardrailMetadata>,
    binding: Option<PromptBinding>,
}

impl StoredPrompt {
    fn observable(&self) -> Option<&GuardrailMetadata> {
        self.guardrail
            .as_ref()
            .filter(|guardrail| guardrail.action != Some(crate::types::GuardrailAction::Block))
    }
}

struct StoreInner {
    tool_verdicts: IndexMap<String, StoredVerdict>,
    prompt_verdicts: IndexMap<PromptKey, StoredPrompt>,
    checkpoint_path: PathBuf,
}

pub struct ToolVerdictStore {
    inner: Mutex<StoreInner>,
    stop: Arc<AtomicBool>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl ToolVerdictStore {
    pub fn new(checkpoint_path: impl Into<PathBuf>) -> Self {
        Self {
            inner: Mutex::new(StoreInner {
                tool_verdicts: IndexMap::new(),
                prompt_verdicts: IndexMap::new(),
                checkpoint_path: checkpoint_path.into(),
            }),
            stop: Arc::new(AtomicBool::new(false)),
            worker: Mutex::new(None),
        }
    }

    pub fn put(&self, key: &ToolVerdictKey, action: ToolVerdictAction, now_ms: i64) {
        self.insert(key, action, None, now_ms, false);
    }

    pub fn put_sdk_verdict(
        &self,
        key: &ToolVerdictKey,
        action: ToolVerdictAction,
        guardrail: Option<GuardrailMetadata>,
        now_ms: i64,
    ) {
        self.insert(key, action, guardrail, now_ms, true);
    }

    fn insert(
        &self,
        key: &ToolVerdictKey,
        action: ToolVerdictAction,
        guardrail: Option<GuardrailMetadata>,
        now_ms: i64,
        retain_block: bool,
    ) {
        if key.tool_use_id.is_empty() {
            return;
        }
        let mut inner = self.inner.lock().expect("verdict store");
        inner.prune(now_ms);
        let key = verdict_key(key);
        // Decide and write under one lock so concurrent allow cannot erase a
        // block from the SDK's other verdict channel.
        if retain_block
            && inner.tool_verdicts.get(&key).is_some_and(|value| {
                value.action == ToolVerdictAction::Block
                    || (value.action == ToolVerdictAction::Log
                        && action == ToolVerdictAction::Allow)
            })
        {
            return;
        }
        let guardrail = guardrail.or_else(|| {
            retain_block
                .then(|| inner.tool_verdicts.get(&key))
                .flatten()
                .filter(|value| value.action == action)
                .and_then(|value| value.guardrail.clone())
        });
        inner.tool_verdicts.insert(
            key,
            StoredVerdict {
                action,
                guardrail,
                recorded_at_ms: now_ms,
            },
        );
    }

    pub fn get(&self, key: &ToolVerdictKey, now_ms: i64) -> Option<ToolVerdictAction> {
        self.get_verdict(key, now_ms).map(|(action, _)| action)
    }

    pub fn get_verdict(
        &self,
        key: &ToolVerdictKey,
        now_ms: i64,
    ) -> Option<(ToolVerdictAction, Option<GuardrailMetadata>)> {
        if key.tool_use_id.is_empty() {
            return None;
        }
        let mut inner = self.inner.lock().expect("verdict store");
        inner.prune(now_ms);
        inner
            .tool_verdicts
            .get(&verdict_key(key))
            .map(|value| (value.action, value.guardrail.clone()))
    }

    pub(crate) fn put_prompt(&self, key: PromptKey, value: Option<GuardrailMetadata>, now_ms: i64) {
        if !key.valid() {
            return;
        }
        let mut inner = self.inner.lock().expect("verdict store");
        if inner.prompt_verdicts.get(&key).is_some_and(|old| {
            old.recorded_at > now_ms
                || (old.recorded_at == now_ms && old.guardrail.is_some() && value.is_none())
        }) {
            return;
        }
        let binding = inner
            .prompt_verdicts
            .shift_remove(&key)
            .filter(|old| old.recorded_at == now_ms)
            .and_then(|old| old.binding);
        inner.prompt_verdicts.insert(
            key,
            StoredPrompt {
                recorded_at: now_ms,
                guardrail: value,
                binding,
            },
        );
        if inner.prompt_verdicts.len() > TOOL_VERDICT_MAX_RECORDS {
            inner.prompt_verdicts.shift_remove_index(0);
        }
    }

    pub(crate) fn get_prompt(
        &self,
        lookup: PromptLookup,
        now_ms: i64,
    ) -> Option<GuardrailMetadata> {
        let mut inner = self.inner.lock().expect("verdict store");
        let fresh = |at: i64| now_ms.saturating_sub(at) <= TOOL_VERDICT_TTL_MS;
        let request_id = lookup.request_id.as_deref();
        if let Some(id) = request_id {
            let exact = PromptKey {
                session_id: lookup.session_id.clone(),
                agent_type: lookup.agent_type.into(),
                prompt_hash: lookup.prompt_hash.clone(),
                request_id: id.into(),
                missing_request_id: false,
                missing_agent_type: false,
            };
            if let Some(stored) = inner.prompt_verdicts.get(&exact) {
                return stored
                    .observable()
                    .filter(|_| fresh(stored.recorded_at))
                    .cloned();
            }
        }
        let candidates = inner
            .prompt_verdicts
            .iter()
            .enumerate()
            .filter(|(_, (key, stored))| fresh(stored.recorded_at) && key.matches_source(&lookup));
        let mut exact = None;
        let mut nearby = None;
        let mut ambiguous = false;
        for (index, (key, stored)) in candidates {
            if request_id.is_some_and(|id| {
                key.request_id == id
                    || stored
                        .binding
                        .as_ref()
                        .is_some_and(|binding| binding.matches(id, lookup.agent_type))
            }) && exact.replace(stored).is_some()
            {
                return None;
            }
            if stored.recorded_at.abs_diff(lookup.at) > MATCH_WINDOW_MS
                || request_id.is_some_and(|id| {
                    stored
                        .binding
                        .as_ref()
                        .is_some_and(|binding| !binding.matches(id, lookup.agent_type))
                })
            {
                continue;
            }
            ambiguous |= nearby.replace(index).is_some();
        }
        if let Some(stored) = exact {
            return stored.observable().cloned();
        }
        if ambiguous {
            return None;
        }
        let (key, stored) = inner.prompt_verdicts.get_index_mut(nearby?)?;
        if stored.binding.is_some() || (request_id.is_some() && !key.missing_request_id) {
            return None;
        }
        let result = stored.observable()?.clone();
        if let Some(id) = request_id {
            stored.binding = Some(PromptBinding {
                request_id: id.into(),
                agent_type: lookup.agent_type.into(),
                at: lookup.at,
            });
        }
        Some(result)
    }

    pub fn restore(&self, now_ms: i64) {
        let mut inner = self.inner.lock().expect("verdict store");
        inner.tool_verdicts.clear();
        inner.prompt_verdicts.clear();
        let text = match fs::read_to_string(&inner.checkpoint_path) {
            Ok(text) => text,
            Err(_) => return,
        };
        let parsed: Value = match serde_json::from_str(&text) {
            Ok(value) => value,
            Err(_) => return,
        };
        let Some(body) = parsed.as_object() else {
            return;
        };
        if body.get("schema").and_then(Value::as_i64) != Some(1) {
            return;
        }
        let Some(records) = body.get("records").and_then(Value::as_array) else {
            return;
        };
        for item in records {
            if item["phase"] == "UserPromptSubmit" {
                let key = serde_json::from_value::<PromptKey>(item.clone());
                let recorded = item["recordedAt"].as_str().and_then(parse_iso_millis);
                if let (Ok(key), Some(recorded)) = (key, recorded) {
                    if key.valid() && now_ms.saturating_sub(recorded) <= TOOL_VERDICT_TTL_MS {
                        let snapshot = if item["action"] == "unknown" {
                            None
                        } else {
                            serde_json::from_value::<GuardrailMetadata>(item.clone()).ok()
                        };
                        if inner.prompt_verdicts.len() == TOOL_VERDICT_MAX_RECORDS {
                            inner.prompt_verdicts.shift_remove_index(0);
                        }
                        let binding = item
                            .get("binding")
                            .and_then(|row| {
                                serde_json::from_value::<PromptBinding>(row.clone()).ok()
                            })
                            .filter(|binding| {
                                key.missing_request_id
                                    && is_qoder(&binding.agent_type)
                                    && (binding.agent_type == key.agent_type
                                        || (key.missing_agent_type
                                            && binding.agent_type != "qoder-cn"))
                                    && valid_digest(&binding.request_id)
                                    && binding.at.abs_diff(recorded) <= MATCH_WINDOW_MS
                            });
                        if item.get("binding").is_some() && binding.is_none() {
                            continue;
                        }
                        inner.prompt_verdicts.insert(
                            key,
                            StoredPrompt {
                                recorded_at: recorded,
                                guardrail: snapshot,
                                binding,
                            },
                        );
                    }
                }
                continue;
            }
            let Some(record) = parse_record(item) else {
                continue;
            };
            let key = ToolVerdictKey {
                session_id: record.session_id.clone(),
                tool_use_id: record.tool_use_id.clone(),
                phase: record.phase,
            };
            inner.tool_verdicts.insert(
                verdict_key(&key),
                StoredVerdict {
                    action: record.action,
                    guardrail: record.guardrail,
                    recorded_at_ms: record.recorded_at_ms,
                },
            );
        }
        inner.prune(now_ms);
    }

    pub fn dump(&self, now_ms: i64) -> std::io::Result<()> {
        let mut inner = self.inner.lock().expect("verdict store");
        inner.prune(now_ms);
        let mut records = Vec::new();
        for (key, value) in &inner.tool_verdicts {
            let Some(parsed) = parse_key(key) else {
                continue;
            };
            records.push(serde_json::to_value(ToolVerdictRecordOut {
                session_id: parsed.session_id,
                tool_use_id: parsed.tool_use_id,
                phase: parsed.phase,
                action: value.action,
                metadata: value
                    .guardrail
                    .as_ref()
                    .map(|g| VerdictDetails {
                        rule_id: g.rule_id.clone(),
                        rule_version: g.rule_version.clone(),
                        fail_open: g.fail_open,
                    })
                    .unwrap_or_default(),
                recorded_at: iso_from_millis(value.recorded_at_ms),
            })?);
        }
        for (key, stored) in &inner.prompt_verdicts {
            if now_ms.saturating_sub(stored.recorded_at) > TOOL_VERDICT_TTL_MS {
                continue;
            }
            let mut row = serde_json::to_value(key)?;
            row["phase"] = Value::from("UserPromptSubmit");
            row["recordedAt"] = Value::from(iso_from_millis(stored.recorded_at));
            if let Some(binding) = &stored.binding {
                row["binding"] = serde_json::to_value(binding)?;
            }
            let fields = stored.guardrail.as_ref().map_or_else(
                || Ok(serde_json::json!({"action":"unknown"})),
                serde_json::to_value,
            )?;
            row.as_object_mut()
                .unwrap()
                .extend(fields.as_object().unwrap().clone());
            records.push(row);
        }
        let text = format!(
            "{}\n",
            serde_json::to_string_pretty(&serde_json::json!({ "schema": 1, "records": records }))
                .unwrap_or_else(|_| "{\"schema\":1,\"records\":[]}".to_string())
        );
        let path = inner.checkpoint_path.clone();
        drop(inner);
        atomic_write(&path, &text)
    }

    pub fn start_checkpoint_loop(self: &Arc<Self>, interval_ms: u64) {
        let mut worker = self.worker.lock().expect("verdict worker");
        if worker.is_some() {
            return;
        }
        self.stop.store(false, Ordering::SeqCst);
        let stop = Arc::clone(&self.stop);
        let store = Arc::clone(self);
        *worker = Some(thread::spawn(move || {
            let pause = Duration::from_millis(interval_ms.max(1));
            while !stop.load(Ordering::SeqCst) {
                // Stop must wake the waiter before joining it. Keep the
                // original checkpoint interval even after a spurious unpark.
                let deadline = std::time::Instant::now() + pause;
                while !stop.load(Ordering::SeqCst) {
                    let Some(remaining) =
                        deadline.checked_duration_since(std::time::Instant::now())
                    else {
                        break;
                    };
                    thread::park_timeout(remaining);
                }
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                let _ = store.dump(chrono::Utc::now().timestamp_millis());
            }
        }));
    }
}

fn verdict_key(key: &ToolVerdictKey) -> String {
    serde_json::to_string(&serde_json::json!([
        key.session_id.clone().unwrap_or_default(),
        key.tool_use_id,
        key.phase.as_str()
    ]))
    .unwrap_or_else(|_| "[]".to_string())
}

fn parse_key(key: &str) -> Option<ToolVerdictKey> {
    let parsed: Value = serde_json::from_str(key).ok()?;
    let items = parsed.as_array()?;
    if items.len() != 3 {
        return None;
    }
    let tool_use_id = items[1].as_str()?.to_string();
    if tool_use_id.is_empty() {
        return None;
    }
    let phase = ToolInterceptPhase::parse(items[2].as_str()?)?;
    let session_raw = &items[0];
    let session_id = match session_raw {
        Value::String(text) if text.is_empty() => None,
        Value::String(text) => Some(text.clone()),
        _ => return None,
    };
    Some(ToolVerdictKey {
        session_id,
        tool_use_id,
        phase,
    })
}

struct ParsedRecord {
    session_id: Option<String>,
    tool_use_id: String,
    phase: ToolInterceptPhase,
    action: ToolVerdictAction,
    guardrail: Option<GuardrailMetadata>,
    recorded_at_ms: i64,
}

fn parse_record(value: &Value) -> Option<ParsedRecord> {
    let record = value.as_object()?;
    let tool_use_id = record.get("toolUseId")?.as_str()?.to_string();
    if tool_use_id.is_empty() {
        return None;
    }
    let phase = ToolInterceptPhase::parse(record.get("phase")?.as_str()?)?;
    let action = ToolVerdictAction::parse(record.get("action")?.as_str()?)?;
    let recorded_at = record.get("recordedAt")?.as_str()?;
    let recorded_at_ms = parse_iso_millis(recorded_at)?;
    let session_id = match record.get("sessionId") {
        None => None,
        Some(Value::String(text)) if text.is_empty() => None,
        Some(Value::String(text)) => Some(text.clone()),
        Some(_) => return None,
    };
    Some(ParsedRecord {
        session_id,
        tool_use_id,
        phase,
        action,
        guardrail: record
            .get("guardrail")
            .and_then(|value| serde_json::from_value(value.clone()).ok())
            .or_else(|| serde_json::from_value(value.clone()).ok()),
        recorded_at_ms,
    })
}

impl StoreInner {
    fn prune(&mut self, now_ms: i64) {
        self.tool_verdicts
            .retain(|_, value| now_ms.saturating_sub(value.recorded_at_ms) <= TOOL_VERDICT_TTL_MS);
    }
}

fn atomic_write(path: &Path, text: &str) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
        }
    }
    let tmp = format!(
        "{}.{}.{}.tmp",
        path.display(),
        std::process::id(),
        hex::encode(&uuid::Uuid::new_v4().as_bytes()[..6])
    );
    {
        let mut file = OpenOptions::new().create_new(true).write(true).open(&tmp)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = file.set_permissions(fs::Permissions::from_mode(0o600));
        }
        file.write_all(text.as_bytes())?;
    }
    fs::rename(&tmp, path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

pub fn iso_from_millis(ms: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms)
        .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_string())
}

fn parse_iso_millis(text: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

impl ToolVerdictStore {
    pub fn stop_checkpoint_loop(&self, now_ms: i64) -> std::io::Result<()> {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.lock().expect("verdict worker").take() {
            worker.thread().unpark();
            let _ = worker.join();
        }
        self.dump(now_ms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::fs;
    use std::path::PathBuf;

    fn file() -> PathBuf {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tool-verdicts.json");
        // Leak the temp dir so the file survives the helper. Tests remove nothing important.
        std::mem::forget(dir);
        path
    }

    fn key(session: Option<&str>, id: &str, phase: ToolInterceptPhase) -> ToolVerdictKey {
        ToolVerdictKey {
            session_id: session.map(str::to_string),
            tool_use_id: id.to_string(),
            phase,
        }
    }

    #[test]
    fn keeps_pre_and_post_apart_and_overwrites_the_same_key() {
        let store = ToolVerdictStore::new(file());
        let now = chrono::DateTime::parse_from_rfc3339("2026-09-23T08:00:00.000Z")
            .unwrap()
            .timestamp_millis();
        store.put(
            &key(Some("s1"), "call-1", ToolInterceptPhase::PreToolUse),
            ToolVerdictAction::Allow,
            now,
        );
        store.put(
            &key(Some("s1"), "call-1", ToolInterceptPhase::PostToolUse),
            ToolVerdictAction::Block,
            now,
        );
        store.put(
            &key(Some("s1"), "call-1", ToolInterceptPhase::PreToolUse),
            ToolVerdictAction::Block,
            now,
        );
        assert_eq!(
            store.get(
                &key(Some("s1"), "call-1", ToolInterceptPhase::PreToolUse),
                now
            ),
            Some(ToolVerdictAction::Block)
        );
        assert_eq!(
            store.get(
                &key(Some("s1"), "call-1", ToolInterceptPhase::PostToolUse),
                now
            ),
            Some(ToolVerdictAction::Block)
        );
        assert_eq!(
            store.get(
                &key(Some("s2"), "call-1", ToolInterceptPhase::PreToolUse),
                now
            ),
            None
        );
    }

    #[test]
    fn drops_records_older_than_30_minutes() {
        let store = ToolVerdictStore::new(file());
        let written = chrono::DateTime::parse_from_rfc3339("2026-09-23T08:00:00.000Z")
            .unwrap()
            .timestamp_millis();
        store.put(
            &key(Some("s1"), "call-1", ToolInterceptPhase::PreToolUse),
            ToolVerdictAction::Allow,
            written,
        );
        assert_eq!(
            store.get(
                &key(Some("s1"), "call-1", ToolInterceptPhase::PreToolUse),
                written + TOOL_VERDICT_TTL_MS
            ),
            Some(ToolVerdictAction::Allow)
        );
        assert_eq!(
            store.get(
                &key(Some("s1"), "call-1", ToolInterceptPhase::PreToolUse),
                written + TOOL_VERDICT_TTL_MS + 1
            ),
            None
        );
    }

    #[test]
    fn dumps_one_checkpoint_file_and_restores_it() {
        let path = file();
        let now = chrono::DateTime::parse_from_rfc3339("2026-09-23T08:00:00.000Z")
            .unwrap()
            .timestamp_millis();
        let store = ToolVerdictStore::new(&path);
        store.put(
            &key(Some("s1"), "call-1", ToolInterceptPhase::PreToolUse),
            ToolVerdictAction::Allow,
            now,
        );
        store.put(
            &key(None, "call-2", ToolInterceptPhase::PostToolUse),
            ToolVerdictAction::Block,
            now,
        );
        store.dump(now).unwrap();
        let raw: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(raw["schema"], 1);
        assert_eq!(raw["records"].as_array().unwrap().len(), 2);
        assert_eq!(raw["records"][0]["sessionId"], "s1");
        assert_eq!(raw["records"][0]["toolUseId"], "call-1");
        assert_eq!(raw["records"][0]["phase"], "PreToolUse");
        assert_eq!(raw["records"][0]["action"], "allow");
        assert_eq!(raw["records"][0]["recordedAt"], "2026-09-23T08:00:00.000Z");
        assert!(raw["records"][1].get("sessionId").is_none());
        assert_eq!(raw["records"][1]["toolUseId"], "call-2");
        assert_eq!(raw["records"][1]["action"], "block");
        assert_eq!(
            raw["records"],
            serde_json::json!([
                {"sessionId":"s1","toolUseId":"call-1","phase":"PreToolUse","action":"allow","recordedAt":"2026-09-23T08:00:00.000Z"},
                {"toolUseId":"call-2","phase":"PostToolUse","action":"block","recordedAt":"2026-09-23T08:00:00.000Z"}
            ])
        );

        let restored = ToolVerdictStore::new(&path);
        restored.restore(now);
        assert_eq!(
            restored.get(
                &key(Some("s1"), "call-1", ToolInterceptPhase::PreToolUse),
                now
            ),
            Some(ToolVerdictAction::Allow)
        );
        assert_eq!(
            restored.get(&key(None, "call-2", ToolInterceptPhase::PostToolUse), now),
            Some(ToolVerdictAction::Block)
        );
    }

    #[test]
    fn ignores_a_corrupt_or_unknown_checkpoint() {
        let path = file();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "{").unwrap();
        let broken = ToolVerdictStore::new(&path);
        broken.restore(0);
        assert_eq!(
            broken.get(&key(None, "call-1", ToolInterceptPhase::PreToolUse), 0),
            None
        );

        fs::write(&path, r#"{"schema":2,"records":[]}"#).unwrap();
        let unknown = ToolVerdictStore::new(&path);
        unknown.restore(0);
        assert_eq!(
            unknown.get(&key(None, "call-1", ToolInterceptPhase::PreToolUse), 0),
            None
        );
    }

    #[test]
    fn does_not_restore_records_older_than_30_minutes() {
        let path = file();
        let written = chrono::DateTime::parse_from_rfc3339("2026-09-23T08:00:00.000Z")
            .unwrap()
            .timestamp_millis();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            serde_json::json!({
                "schema": 1,
                "records": [{
                    "sessionId": "s1",
                    "toolUseId": "call-1",
                    "phase": "PreToolUse",
                    "action": "block",
                    "recordedAt": "2026-09-23T08:00:00.000Z"
                }]
            })
            .to_string(),
        )
        .unwrap();
        let store = ToolVerdictStore::new(&path);
        store.restore(written + TOOL_VERDICT_TTL_MS + 1);
        assert_eq!(
            store.get(
                &key(Some("s1"), "call-1", ToolInterceptPhase::PreToolUse),
                written + TOOL_VERDICT_TTL_MS + 1
            ),
            None
        );
    }
}

#[cfg(test)]
mod checkpoint_shutdown_tests {
    use super::*;

    #[test]
    fn stop_wakes_a_long_checkpoint_interval_and_durably_flushes_before_return() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("verdicts.json");
        let store = Arc::new(ToolVerdictStore::new(path.to_string_lossy().into_owned()));
        let key = ToolVerdictKey {
            session_id: Some("synthetic-session".into()),
            tool_use_id: "synthetic-tool".into(),
            phase: ToolInterceptPhase::PreToolUse,
        };
        let now = chrono::Utc::now().timestamp_millis();
        store.put(&key, ToolVerdictAction::Block, now);
        store.start_checkpoint_loop(60_000);
        std::thread::sleep(Duration::from_millis(25));
        let started = std::time::Instant::now();
        store.stop_checkpoint_loop(now).unwrap();
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(store.worker.lock().unwrap().is_none());
        let restored = ToolVerdictStore::new(path.to_string_lossy().into_owned());
        restored.restore(now);
        assert_eq!(restored.get(&key, now), Some(ToolVerdictAction::Block));
        store.stop_checkpoint_loop(now).unwrap();
    }
}
