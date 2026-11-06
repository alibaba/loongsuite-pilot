//! Recoverable per-work lineage. Plaintext work and result bodies never enter
//! this state: work uses a normalized digest, result equality an exact digest.
use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::*;
use crate::inputs::codex_transcript::types::CodexTerminalStatus;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorkBinding {
    child_thread_id: String,
    child_turn_id: String,
    invocation_id: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CompletedResult {
    invocation_id: String,
    child_thread_id: String,
    child_turn_id: String,
    fingerprint: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorkTerminal {
    invocation_id: String,
    child_thread_id: String,
    child_turn_id: String,
    terminal_type: String,
}

impl FactValue for WorkBinding {
    fn scopes(&self) -> Vec<FactScope> {
        vec![FactScope::Child(self.child_thread_id.clone())]
    }
}
impl FactValue for CompletedResult {
    fn scopes(&self) -> Vec<FactScope> {
        vec![FactScope::Invocation(self.invocation_id.clone())]
    }
}
impl FactValue for WorkTerminal {
    fn scopes(&self) -> Vec<FactScope> {
        vec![FactScope::Invocation(self.invocation_id.clone())]
    }
}

fn digest(value: &str, length: usize) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))[..length].to_owned()
}
fn work_fingerprint(value: &str) -> String {
    digest(value.replace("\r\n", "\n").trim(), 64)
}
fn key(thread: &str, turn: &str) -> String {
    json!([thread, turn]).to_string()
}
fn string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}
fn field(value: Option<&Value>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| string(value.and_then(|value| value.get(*key))))
}
fn parsed(value: Option<&Value>) -> Value {
    match value {
        Some(Value::String(text)) => serde_json::from_str(text).unwrap_or(Value::Null),
        Some(value) => value.clone(),
        None => Value::Null,
    }
}
fn message(value: Option<&Value>) -> Option<String> {
    let text = match value? {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    (!text.trim().is_empty()).then_some(text)
}
pub(super) fn complete_descriptor(mut spawn: CodexSpawnDescriptor) -> CodexSpawnDescriptor {
    if spawn.parent_tool_span_id.is_none() {
        spawn.parent_tool_span_id = Some(digest(
            &[
                &spawn.parent_thread_id,
                &spawn.parent_turn_id,
                "tool",
                &spawn.parent_tool_call_id,
            ]
            .join("\0"),
            16,
        ));
    }
    if spawn.invocation_id.is_none() {
        spawn.invocation_id = Some(digest(
            &json!([
                "codex-delegation",
                spawn.parent_thread_id,
                spawn.parent_turn_id,
                spawn.parent_tool_call_id,
                spawn.work_index
            ])
            .to_string(),
            32,
        ));
    }
    spawn.result_fingerprints.clear();
    spawn.result_terminal_observed = false;
    spawn.result_child_turn_ids.clear();
    spawn.result_outcome_known = false;
    spawn
}

fn matches_child(spawn: &CodexSpawnDescriptor, child: &CodexChildThreadDescriptor) -> bool {
    if let Some(id) = spawn
        .child_thread_id
        .as_ref()
        .or(spawn.resolved_child_thread_id.as_ref())
    {
        return id == &child.child_thread_id;
    }
    spawn.parent_thread_id == child.parent_thread_id
        && child.agent_path.as_ref().is_some_and(|path| {
            spawn
                .agent_path
                .as_ref()
                .or(spawn.task_name.as_ref())
                .is_some_and(|candidate| {
                    normalize_agent_path(candidate) == normalize_agent_path(path)
                })
        })
}
fn input_payload<'a>(source: &'a CodexTranscriptSourceRecord, turn: &str) -> Option<&'a Value> {
    let payload = source.record.get("payload")?;
    let record_turn = field(
        Some(
            payload
                .get("internal_chat_message_metadata_passthrough")
                .unwrap_or(&Value::Null),
        ),
        &["turn_id"],
    )
    .or_else(|| field(Some(payload), &["turn_id"]));
    if record_turn.as_deref().is_some_and(|id| id != turn) {
        return None;
    }
    Some(payload)
}
fn injected_context(payload: &Value) -> bool {
    payload
        .get("content")
        .and_then(Value::as_array)
        .is_some_and(|parts| {
            !parts.is_empty()
                && parts.iter().all(|part| {
                    if part.get("type").and_then(Value::as_str) != Some("input_text") {
                        return false;
                    }
                    part.get("text")
                        .and_then(Value::as_str)
                        .is_some_and(|text| {
                            let text = text.trim();
                            (text.starts_with("# AGENTS.md instructions")
                                && text.contains("<INSTRUCTIONS>")
                                && text.ends_with("</INSTRUCTIONS>"))
                                || (text.starts_with("<environment_context>")
                                    && text.ends_with("</environment_context>"))
                        })
                })
        })
}
fn direct_input(source: &CodexTranscriptSourceRecord, turn: &str) -> bool {
    let Some(payload) = input_payload(source, turn) else {
        return false;
    };
    (source.record["type"] == "response_item"
        && payload["type"] == "message"
        && payload["role"] == "user"
        && !injected_context(payload))
        || (source.record["type"] == "event_msg" && payload["type"] == "user_message")
}
fn agent_input(source: &CodexTranscriptSourceRecord, turn: &str) -> bool {
    let Some(payload) = input_payload(source, turn) else {
        return false;
    };
    if source.record["type"] != "response_item" || payload["type"] != "agent_message" {
        return false;
    }
    let text = message(payload.get("content")).or_else(|| message(payload.get("message")));
    !text.as_deref().is_some_and(|text| {
        text.trim_start()
            .strip_prefix("Message Type:")
            .and_then(|tail| tail.split_whitespace().next())
            == Some("FINAL_ANSWER")
    })
}
pub fn is_codex_work_input(source: &CodexTranscriptSourceRecord, turn: &str) -> bool {
    direct_input(source, turn) || agent_input(source, turn)
}
fn fingerprints(turn: &str, sources: &[CodexTranscriptSourceRecord]) -> HashSet<String> {
    let mut plain = HashSet::new();
    let mut opaque = HashSet::new();
    for source in sources.iter().filter(|source| agent_input(source, turn)) {
        let Some(payload) = input_payload(source, turn) else {
            continue;
        };
        if let Some(parts) = payload.get("content").and_then(Value::as_array) {
            for part in parts {
                if part["type"] == "encrypted_content" {
                    if let Some(text) = part.get("encrypted_content").and_then(Value::as_str) {
                        opaque.insert(work_fingerprint(text));
                    }
                }
            }
        }
        if let Some(text) =
            message(payload.get("content")).or_else(|| message(payload.get("message")))
        {
            plain.insert(work_fingerprint(&text));
        }
    }
    if opaque.is_empty() {
        plain
    } else {
        opaque
    }
}

impl CodexSubagentLinker {
    pub fn serialize(&self) -> Value {
        self.serialized_cache.get(
            [
                self.spawns.revision(),
                self.children.revision(),
                self.bindings.revision(),
                self.completed_results.revision(),
                self.work_terminals.revision(),
            ],
            || {
                json!({"version": 1, "spawns": self.spawns.values().collect::<Vec<_>>(),
            "children": self.children.values().collect::<Vec<_>>(),
            "bindings": self.bindings.values().collect::<Vec<_>>(),
            "completedWorkResults": self.completed_results.values().collect::<Vec<_>>(),
            "workTerminals": self.work_terminals.values().collect::<Vec<_>>() })
            },
        )
    }
    pub fn restore(&mut self, value: &Value) {
        if value["version"] != 1 {
            return;
        }
        if let Some(spawns) = value["spawns"].as_array() {
            for value in spawns {
                // Old checkpoints may contain workPrompt. Hash only that
                // legacy input, then discard it before constructing persistent
                // descriptors; an already stored fingerprint takes precedence.
                let mut restored = value.clone();
                let legacy_fingerprint = restored
                    .as_object_mut()
                    .and_then(|fields| fields.remove("workPrompt"))
                    .and_then(|prompt| {
                        prompt
                            .as_str()
                            .filter(|text| !text.is_empty())
                            .map(work_fingerprint)
                    });
                if let Ok(mut spawn) = serde_json::from_value::<CodexSpawnDescriptor>(restored) {
                    if spawn.work_fingerprint.is_none() {
                        spawn.work_fingerprint = legacy_fingerprint;
                    }
                    if !spawn.parent_thread_id.is_empty()
                        && !spawn.parent_turn_id.is_empty()
                        && !spawn.parent_trace_id.is_empty()
                        && !spawn.parent_tool_call_id.is_empty()
                        && spawn.spawned_at_ms.is_finite()
                    {
                        self.register_spawns(&[spawn]);
                    }
                }
            }
        }
        if let Some(children) = value["children"].as_array() {
            for value in children {
                if let Ok(child) =
                    serde_json::from_value::<CodexChildThreadDescriptor>(value.clone())
                {
                    if !child.child_thread_id.is_empty()
                        && !child.parent_thread_id.is_empty()
                        && !child.root_session_id.is_empty()
                        && child.created_at_ms.is_finite()
                    {
                        self.children.insert(child.child_thread_id.clone(), child);
                    }
                }
            }
        }
        if let Some(bindings) = value["bindings"].as_array() {
            for value in bindings {
                if let Ok(binding) = serde_json::from_value::<WorkBinding>(value.clone()) {
                    if !binding.child_thread_id.is_empty()
                        && !binding.child_turn_id.is_empty()
                        && !binding.invocation_id.is_empty()
                    {
                        self.bindings.insert(
                            key(&binding.child_thread_id, &binding.child_turn_id),
                            binding,
                        );
                    }
                }
            }
        }
        if let Some(results) = value["completedWorkResults"].as_array() {
            for value in results {
                if let Ok(result) = serde_json::from_value::<CompletedResult>(value.clone()) {
                    if !result.invocation_id.is_empty()
                        && !result.child_thread_id.is_empty()
                        && !result.child_turn_id.is_empty()
                        && result.fingerprint.len() == 64
                        && result
                            .fingerprint
                            .bytes()
                            .all(|ch| ch.is_ascii_digit() || (b'a'..=b'f').contains(&ch))
                    {
                        self.completed_results.insert(
                            json!([
                                result.invocation_id,
                                result.child_thread_id,
                                result.child_turn_id,
                                result.fingerprint
                            ])
                            .to_string(),
                            result,
                        );
                    }
                }
            }
        }
        if let Some(terminals) = value["workTerminals"].as_array() {
            for value in terminals {
                if let Ok(terminal) = serde_json::from_value::<WorkTerminal>(value.clone()) {
                    if !terminal.invocation_id.is_empty()
                        && !terminal.child_thread_id.is_empty()
                        && !terminal.child_turn_id.is_empty()
                        && matches!(terminal.terminal_type.as_str(), "completed" | "interrupted")
                    {
                        self.work_terminals.insert(
                            json!([
                                terminal.invocation_id,
                                terminal.child_thread_id,
                                terminal.child_turn_id
                            ])
                            .to_string(),
                            terminal,
                        );
                    }
                }
            }
        }
        trim_oldest(&mut self.children, MAX_LINK_DESCRIPTORS);
        trim_oldest(&mut self.bindings, MAX_LINK_DESCRIPTORS);
        trim_oldest(&mut self.completed_results, MAX_LINK_DESCRIPTORS);
        trim_oldest(&mut self.work_terminals, MAX_LINK_DESCRIPTORS);
    }

    pub fn resolve_work(
        &mut self,
        meta: &CodexTranscriptMeta,
        turn: &CodexExtractedTranscriptTurn,
        records: &[CodexTranscriptSourceRecord],
        allow_creation_fallback: bool,
    ) -> Option<CodexSubagentLink> {
        self.register_child(meta);
        let child = self.children.get(&meta.thread_id)?.clone();
        let mut scopes = vec![FactScope::Child(meta.thread_id.clone())];
        if let Some(path) = &child.agent_path {
            scopes.push(FactScope::ParentPath(
                child.parent_thread_id.clone(),
                normalize_agent_path(path),
            ));
        }
        let candidates: Vec<_> = self
            .spawns
            .scoped_values(&scopes)
            .into_iter()
            .filter(|spawn| {
                !spawn.dispatch_failed
                    && !spawn.association_conflict
                    && matches_child(spawn, &child)
                    && spawn.spawned_at_ms <= turn.started_at_ms
            })
            .cloned()
            .collect();
        let direct = records
            .iter()
            .any(|source| direct_input(source, &turn.transcript_turn_id));
        let previous = self
            .bindings
            .scoped_values(&[FactScope::Child(meta.thread_id.clone())]);
        if direct && !(allow_creation_fallback && previous.is_empty()) {
            return None;
        }
        let fingerprints = fingerprints(&turn.transcript_turn_id, records);
        if fingerprints.len() > 1 || (direct && !fingerprints.is_empty()) {
            return None;
        }
        let creations: Vec<_> = candidates
            .iter()
            .filter(|spawn| {
                spawn
                    .dispatch_kind
                    .as_deref()
                    .is_none_or(|kind| kind == "spawn")
            })
            .collect();
        if direct && creations.len() != 1 {
            return None;
        }
        let explicit: Vec<_> = candidates
            .iter()
            .filter(|spawn| spawn.child_turn_id.as_deref() == Some(&turn.transcript_turn_id))
            .collect();
        let matching: Vec<_> = candidates
            .iter()
            .filter(|spawn| {
                spawn
                    .work_fingerprint
                    .as_ref()
                    .is_some_and(|hash| fingerprints.contains(hash))
            })
            .collect();
        if explicit.len() > 1 || (explicit.is_empty() && matching.len() > 1) {
            return None;
        }
        let mut selected = if direct {
            creations.first().copied()
        } else {
            explicit.first().or(matching.first()).copied()
        };
        if selected.is_none() && fingerprints.is_empty() {
            if let Some(saved) = self
                .bindings
                .get(&key(&meta.thread_id, &turn.transcript_turn_id))
            {
                selected = candidates
                    .iter()
                    .find(|spawn| spawn.invocation_id.as_deref() == Some(&saved.invocation_id));
            }
        }
        if selected.is_none()
            && allow_creation_fallback
            && previous.is_empty()
            && creations.len() == 1
        {
            selected = creations.first().copied();
        }
        if selected.is_none() && fingerprints.is_empty() && !direct && turn.prompt.is_none() {
            let ids: HashSet<_> = previous
                .iter()
                .map(|binding| binding.invocation_id.as_str())
                .collect();
            if ids.len() == 1 {
                selected = candidates.iter().find(|spawn| {
                    spawn
                        .invocation_id
                        .as_deref()
                        .is_some_and(|id| ids.contains(id))
                });
            }
        }
        let mut selected = selected?.clone();
        let invocation_id = selected.invocation_id.clone()?;
        self.bindings.insert(
            key(&meta.thread_id, &turn.transcript_turn_id),
            WorkBinding {
                child_thread_id: meta.thread_id.clone(),
                child_turn_id: turn.transcript_turn_id.clone(),
                invocation_id,
            },
        );
        trim_oldest(&mut self.bindings, MAX_LINK_DESCRIPTORS);
        if selected.child_thread_id.is_none() && selected.resolved_child_thread_id.is_none() {
            selected.resolved_child_thread_id = Some(meta.thread_id.clone());
            self.spawns.insert(spawn_key(&selected), selected.clone());
        }
        let confidence = if selected.child_thread_id.is_some() {
            CodexSubagentLinkConfidence::ExplicitId
        } else {
            CodexSubagentLinkConfidence::AgentPath
        };
        let mut link = linked_child(&child, &selected, confidence);
        link.child_turn_id = Some(turn.transcript_turn_id.clone());
        Some(link)
    }

    pub fn register_completed_work_result(
        &mut self,
        link: &CodexSubagentLink,
        turn: &CodexExtractedTranscriptTurn,
        records: &[CodexTranscriptSourceRecord],
    ) {
        let Some(invocation) = &link.invocation_id else {
            return;
        };
        if !matches!(
            link.confidence,
            CodexSubagentLinkConfidence::ExplicitId | CodexSubagentLinkConfidence::AgentPath
        ) || link.child_thread_id != turn.session_id
            || link
                .child_turn_id
                .as_ref()
                .is_some_and(|id| id != &turn.transcript_turn_id)
        {
            return;
        }
        for source in records {
            let payload = &source.record["payload"];
            if source.record["type"] != "event_msg" || payload["turn_id"] != turn.transcript_turn_id
            {
                continue;
            }
            let terminal_type = match (payload["type"].as_str(), turn.status) {
                (Some("task_complete"), CodexTerminalStatus::Completed) => "completed",
                (Some("turn_aborted"), CodexTerminalStatus::Interrupted) => "interrupted",
                _ => continue,
            };
            self.work_terminals.insert(
                json!([invocation, turn.session_id, turn.transcript_turn_id]).to_string(),
                WorkTerminal {
                    invocation_id: invocation.clone(),
                    child_thread_id: turn.session_id.clone(),
                    child_turn_id: turn.transcript_turn_id.clone(),
                    terminal_type: terminal_type.into(),
                },
            );
            if terminal_type == "completed" {
                if let Some(body) = payload["last_agent_message"].as_str() {
                    let fingerprint = digest(body, 64);
                    self.completed_results.insert(
                        json!([
                            invocation,
                            turn.session_id,
                            turn.transcript_turn_id,
                            fingerprint
                        ])
                        .to_string(),
                        CompletedResult {
                            invocation_id: invocation.clone(),
                            child_thread_id: turn.session_id.clone(),
                            child_turn_id: turn.transcript_turn_id.clone(),
                            fingerprint,
                        },
                    );
                }
            }
        }
        trim_oldest(&mut self.completed_results, MAX_LINK_DESCRIPTORS);
        trim_oldest(&mut self.work_terminals, MAX_LINK_DESCRIPTORS);
    }

    pub fn get_delegations_for_parent(&self, parent: &str) -> Vec<CodexSpawnDescriptor> {
        #[cfg(test)]
        self.delegation_queries
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.spawns
            .scoped_values(&[FactScope::Parent(parent.into())])
            .into_iter()
            .map(|spawn| {
                let mut copy = spawn.clone();
                let results = spawn
                    .invocation_id
                    .as_ref()
                    .map(|id| {
                        self.completed_results
                            .scoped_values(&[FactScope::Invocation(id.clone())])
                    })
                    .unwrap_or_default();
                let terminals = spawn
                    .invocation_id
                    .as_ref()
                    .map(|id| {
                        self.work_terminals
                            .scoped_values(&[FactScope::Invocation(id.clone())])
                    })
                    .unwrap_or_default();
                copy.result_terminal_observed = !results.is_empty() || !terminals.is_empty();
                copy.result_outcome_known = copy.result_terminal_observed
                    && terminals.iter().all(|terminal| {
                        terminal.terminal_type == "interrupted"
                            || results.iter().any(|result| {
                                result.child_thread_id == terminal.child_thread_id
                                    && result.child_turn_id == terminal.child_turn_id
                            })
                    });
                // Distinct native turns remain distinct durable facts, while
                // callers need each exact result digest only once.
                let mut seen_fingerprints = HashSet::new();
                copy.result_fingerprints = results
                    .iter()
                    .filter(|result| seen_fingerprints.insert(result.fingerprint.as_str()))
                    .map(|result| result.fingerprint.clone())
                    .collect();
                copy.result_child_turn_ids = terminals
                    .iter()
                    .map(|terminal| terminal.child_turn_id.clone())
                    .chain(results.iter().map(|result| result.child_turn_id.clone()))
                    .collect();
                copy.result_child_turn_ids.sort();
                copy.result_child_turn_ids.dedup();
                let path = spawn.agent_path.as_ref().or(spawn.task_name.as_ref());
                let known_id = spawn
                    .child_thread_id
                    .as_ref()
                    .or(spawn.resolved_child_thread_id.as_ref());
                let known = known_id.and_then(|id| self.children.get(id));
                if copy.agent_path.is_none() {
                    copy.agent_path = known.and_then(|child| child.agent_path.clone());
                }
                if copy.agent_nickname.is_none() {
                    copy.agent_nickname = known.and_then(|child| child.agent_nickname.clone());
                }
                if spawn.child_thread_id.is_some()
                    || spawn.dispatch_failed
                    || spawn.association_conflict
                {
                    return copy;
                }
                if let Some(id) = &spawn.resolved_child_thread_id {
                    copy.child_thread_id = Some(id.clone());
                    return copy;
                }
                if let Some(path) = path {
                    let creations = self
                        .spawns
                        .scoped_values(&[FactScope::CreationPath(
                            parent.into(),
                            normalize_agent_path(path),
                        )])
                        .len();
                    if creations > 1 {
                        return copy;
                    }
                    let children = self.children.scoped_values(&[FactScope::ParentPath(
                        parent.into(),
                        normalize_agent_path(path),
                    )]);
                    if children.len() == 1 {
                        copy.child_thread_id = Some(children[0].child_thread_id.clone());
                        if copy.agent_nickname.is_none() {
                            copy.agent_nickname = children[0].agent_nickname.clone();
                        }
                    }
                }
                copy
            })
            .collect()
    }
}

fn select_activity<'a>(
    activities: &'a [Value],
    result: Option<&Value>,
    task: Option<&Value>,
    count: usize,
    activity_only_index: Option<usize>,
) -> (Option<&'a Value>, bool) {
    if let Some(index) = activity_only_index {
        return (activities.get(index), false);
    }
    let child = field(result, &["agent_id", "thread_id", "agent_thread_id"])
        .or_else(|| field(task, &["agent_id", "thread_id", "id"]));
    if let Some(child) = child {
        let matching: Vec<_> = activities
            .iter()
            .filter(|activity| {
                field(Some(activity), &["agent_thread_id", "agent_id"]).as_ref() == Some(&child)
            })
            .collect();
        return match matching.as_slice() {
            [only] => (Some(*only), false),
            [] => (None, count == 1 && !activities.is_empty()),
            _ => (None, true),
        };
    }
    let path = field(result, &["agent_path", "task_path", "task_name"])
        .or_else(|| field(task, &["agent_path", "task_path", "task_name", "target"]));
    let task_id = field(result, &["task_id"]).or_else(|| field(task, &["task_id"]));
    if path.is_some() || task_id.is_some() {
        let matching: Vec<_> = activities
            .iter()
            .filter(|activity| {
                if task_id.is_some() && field(Some(activity), &["task_id"]) == task_id {
                    return true;
                }
                path.as_ref().is_some_and(|path| {
                    field(Some(activity), &["agent_path", "task_path", "task_name"]).is_some_and(
                        |candidate| normalize_agent_path(&candidate) == normalize_agent_path(path),
                    )
                })
            })
            .collect();
        match matching.as_slice() {
            [only] => return (Some(*only), false),
            [] => {
                if count == 1
                    && activities.len() == 1
                    && ((path.is_some()
                        && field(
                            activities.first(),
                            &["agent_path", "task_path", "task_name"],
                        )
                        .is_some())
                        || (task_id.is_some() && field(activities.first(), &["task_id"]).is_some()))
                {
                    return (None, true);
                }
            }
            _ => return (None, true),
        }
    }
    if count == 1 && activities.len() == 1 {
        (activities.first(), false)
    } else {
        (None, false)
    }
}

pub(super) fn extract_dispatches(
    turn: &CodexExtractedTranscriptTurn,
    sources: &[CodexTranscriptSourceRecord],
    parent_trace: &str,
) -> Vec<CodexSpawnDescriptor> {
    let mut activities: IndexMap<String, Vec<Value>> = IndexMap::new();
    for source in sources {
        let payload = &source.record["payload"];
        if source.record["type"] != "event_msg"
            || payload["type"] != "sub_agent_activity"
            || payload["kind"] != "started"
        {
            continue;
        }
        if let Some(call) = field(Some(payload), &["event_id", "call_id", "tool_call_id"]) {
            let group = activities.entry(call).or_default();
            let identity = |value: &Value| {
                json!([
                    field(Some(value), &["agent_thread_id", "agent_id"]),
                    field(Some(value), &["agent_path", "task_path"]),
                    value["turn_id"]
                ])
            };
            if !group
                .iter()
                .any(|existing| identity(existing) == identity(payload))
            {
                group.push(payload.clone());
            }
        }
    }
    let mut descriptors = Vec::new();
    for step in &turn.steps {
        for tool in &step.tools {
            let name = tool.name.rsplit(['.', '/']).next().unwrap_or(&tool.name);
            let kind = match name {
                "spawn_agent" => "spawn",
                "followup_task" => "followup",
                "send_input" => "input",
                _ => continue,
            };
            let input = parsed(tool.input.as_ref());
            let output = parsed(tool.output.as_ref());
            let tasks = input
                .get("agents")
                .or_else(|| input.get("tasks"))
                .and_then(Value::as_array);
            let results = output
                .get("agents")
                .or_else(|| output.get("tasks"))
                .and_then(Value::as_array)
                .or_else(|| output.as_array());
            let activity = activities
                .get(&tool.call_id)
                .map(Vec::as_slice)
                .unwrap_or_default();
            let count = tasks
                .map_or(0, Vec::len)
                .max(results.map_or(0, Vec::len))
                .max(activity.len())
                .max(1);
            for index in 0..count {
                let task = tasks.map(|tasks| tasks.get(index)).unwrap_or(Some(&input));
                let result = results
                    .map(|results| results.get(index))
                    .unwrap_or_else(|| (count == 1).then_some(&output));
                let (started, conflict) = select_activity(
                    activity,
                    result,
                    task,
                    count,
                    (tasks.is_none() && results.is_none() && count > 1).then_some(index),
                );
                let prompt = task.and_then(|task| {
                    message(task.get("message"))
                        .or_else(|| message(task.get("prompt")))
                        .or_else(|| message(task.get("input")))
                });
                if kind != "spawn"
                    && (prompt.is_none()
                        || ["cancel", "notification", "notify_only", "notification_only"]
                            .iter()
                            .any(|key| {
                                task.and_then(|task| task.get(*key)) == Some(&Value::Bool(true))
                            }))
                {
                    continue;
                }
                let child = field(started, &["agent_thread_id", "agent_id"])
                    .or_else(|| field(result, &["agent_id", "thread_id", "agent_thread_id"]))
                    .or_else(|| {
                        (kind != "spawn")
                            .then(|| field(task, &["id", "agent_id", "thread_id"]))
                            .flatten()
                    });
                let path = field(started, &["agent_path", "task_path"])
                    .or_else(|| field(result, &["agent_path", "task_path", "task_name"]))
                    .or_else(|| {
                        (kind != "spawn")
                            .then(|| field(task, &["target"]))
                            .flatten()
                    });
                let failed_text = tool
                    .output
                    .as_ref()
                    .and_then(Value::as_str)
                    .map(str::to_lowercase);
                let failed = output
                    .get("error")
                    .is_some_and(|error| !error.is_null() && error != &Value::Bool(false))
                    || matches!(output["status"].as_str(), Some("failed" | "rejected"))
                    || failed_text.as_ref().is_some_and(|text| {
                        ["spawn failed", "spawn rejected", "agent thread limit"]
                            .iter()
                            .any(|pattern| text.contains(pattern))
                    });
                descriptors.push(complete_descriptor(CodexSpawnDescriptor {
                    parent_thread_id: turn.session_id.clone(),
                    parent_turn_id: turn.transcript_turn_id.clone(),
                    parent_trace_id: parent_trace.into(),
                    parent_tool_call_id: tool.call_id.clone(),
                    spawned_at_ms: started
                        .and_then(|value| value["occurred_at_ms"].as_f64())
                        .unwrap_or(tool.started_at_ms),
                    task_name: field(task, &["task_name", "agent_path"]),
                    agent_path: path,
                    child_thread_id: child,
                    dispatch_kind: Some(kind.into()),
                    work_index: index,
                    work_fingerprint: prompt.as_deref().map(work_fingerprint),
                    child_turn_id: field(started, &["turn_id"])
                        .or_else(|| field(result, &["turn_id"])),
                    agent_nickname: field(result, &["nickname"]),
                    dispatch_failed: failed,
                    association_conflict: conflict,
                    ..Default::default()
                }));
            }
        }
    }
    descriptors
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inputs::codex_transcript::CodexTranscriptStep;

    fn meta() -> CodexTranscriptMeta {
        CodexTranscriptMeta {
            thread_id: "child".into(),
            root_session_id: "parent".into(),
            thread_source: super::super::super::types::CodexThreadSource::Subagent,
            parent_thread_id: Some("parent".into()),
            forked_from_id: None,
            depth: 2,
            created_at_ms: Some(1.0),
            agent_path: Some("/root/worker".into()),
            agent_nickname: Some("Worker".into()),
            agent_role: None,
            provider: "openai".into(),
            base_instructions: None,
            tool_definitions: None,
        }
    }
    fn turn(id: &str) -> CodexExtractedTranscriptTurn {
        CodexExtractedTranscriptTurn {
            session_id: "child".into(),
            transcript_turn_id: id.into(),
            provider: "openai".into(),
            model: "model".into(),
            status: CodexTerminalStatus::Completed,
            started_at_ms: 100.0,
            terminal_at_ms: 200.0,
            prompt: None,
            prompt_ready: false,
            input_messages: Vec::new(),
            cwd: None,
            developer_instructions: None,
            base_instructions: None,
            tool_definitions: None,
            steps: Vec::new(),
            unmatched_token_usages: Vec::new(),
        }
    }
    fn spawn(call: &str, prompt: &str) -> CodexSpawnDescriptor {
        complete_descriptor(CodexSpawnDescriptor {
            parent_thread_id: "parent".into(),
            parent_turn_id: "parent-turn".into(),
            parent_trace_id: "0123456789abcdef0123456789abcdef".into(),
            parent_tool_call_id: call.into(),
            spawned_at_ms: 1.0,
            child_thread_id: Some("child".into()),
            work_fingerprint: Some(work_fingerprint(prompt)),
            dispatch_kind: Some("followup".into()),
            ..Default::default()
        })
    }
    fn source(payload: Value) -> CodexTranscriptSourceRecord {
        CodexTranscriptSourceRecord {
            start_offset: 0,
            end_offset: 100,
            record: json!({"type":"response_item","payload":payload})
                .as_object()
                .unwrap()
                .clone(),
        }
    }
    #[test]
    fn followup_work_is_bound_by_native_input_and_survives_restart_without_plaintext() {
        let mut linker = CodexSubagentLinker::new();
        linker.register_spawns(&[
            spawn("first", "first task"),
            spawn("second", "secret second task"),
        ]);
        let input = source(
            json!({"type":"agent_message","content":[{"type":"input_text","text":"secret second task"}]}),
        );
        let link = linker
            .resolve_work(&meta(), &turn("second-turn"), &[input], false)
            .unwrap();
        assert_eq!(link.parent_tool_call_id.as_deref(), Some("second"));
        assert_eq!(link.child_turn_id.as_deref(), Some("second-turn"));
        let state = linker.serialize();
        assert!(!state.to_string().contains("secret second task"));
        let mut restored = CodexSubagentLinker::new();
        restored.restore(&state);
        let link2 = restored
            .resolve_work(&meta(), &turn("second-turn"), &[], false)
            .unwrap();
        assert_eq!(link.invocation_id, link2.invocation_id);
        assert_eq!(link2.child_thread_id, "child");
    }

    #[test]
    fn direct_user_input_ambiguous_messages_and_notifications_never_claim_latest_work() {
        let mut linker = CodexSubagentLinker::new();
        linker.register_spawns(&[spawn("first", "same text"), spawn("second", "other")]);
        let direct = source(
            json!({"type":"message","role":"user","content":[{"type":"input_text","text":"same text"}]}),
        );
        assert!(linker
            .resolve_work(&meta(), &turn("direct"), &[direct], false)
            .is_none());
        let messages = [
            source(json!({"type":"agent_message","content":[{"text":"same text"}]})),
            source(json!({"type":"agent_message","content":[{"text":"other"}]})),
        ];
        assert!(linker
            .resolve_work(&meta(), &turn("ambiguous"), &messages, false)
            .is_none());
        let notification = source(
            json!({"type":"agent_message","content":[{"text":"Message Type: FINAL_ANSWER\nPayload:\nsame text"}]}),
        );
        assert!(linker
            .resolve_work(&meta(), &turn("result"), &[notification], false)
            .is_none());
    }

    #[test]
    fn exact_result_fingerprints_and_terminal_facts_are_persisted_separately() {
        let mut linker = CodexSubagentLinker::new();
        let mut work = spawn("call", "task");
        work.child_turn_id = Some("native-turn".into());
        linker.register_spawns(&[work]);
        let turn = turn("native-turn");
        let link = linker.resolve_work(&meta(), &turn, &[], false).unwrap();
        let terminal = CodexTranscriptSourceRecord {
            start_offset: 10,
            end_offset: 50,
            record:
                json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"native-turn",
                "last_agent_message":"exact result\n"}})
                .as_object()
                .unwrap()
                .clone(),
        };
        linker.register_completed_work_result(&link, &turn, &[terminal]);
        let descriptor = &linker.get_delegations_for_parent("parent")[0];
        assert!(descriptor.result_terminal_observed && descriptor.result_outcome_known);
        assert_eq!(
            descriptor.result_fingerprints,
            [digest("exact result\n", 64)]
        );
        assert_ne!(descriptor.result_fingerprints, [digest("exact result", 64)]);
        let state = linker.serialize();
        assert!(!state.to_string().contains("exact result"));
        assert!(state["spawns"][0].get("resultFingerprints").is_none());
        let mut restored = CodexSubagentLinker::new();
        restored.restore(&state);
        assert_eq!(
            restored.get_delegations_for_parent("parent")[0].result_fingerprints,
            descriptor.result_fingerprints
        );
    }

    #[test]
    fn batched_dispatch_positions_and_failed_or_notification_inputs_are_preserved() {
        let mut parent = turn("parent-turn");
        parent.session_id = "parent".into();
        parent.steps = vec![CodexTranscriptStep {
            started_at_ms: 1.0,
            response_at_ms: 2.0,
            has_response_evidence: true,
            completed_at_ms: 3.0,
            response_id: None,
            input_messages: None,
            reasoning: Vec::new(),
            token_usage: None,
            final_text: None,
            tools: vec![
                super::super::super::types::CodexTranscriptTool {
                    call_id: "batch".into(),
                    name: "collaboration.spawn_agent".into(),
                    input: Some(json!({"tasks":[
                        {"task_name":"one","message":"private one"},null,{"task_name":"three","message":"private three"}]})),
                    started_at_ms: 1.0,
                    output: Some(json!({"tasks":[{"agent_id":"c1"},null,{"agent_id":"c3"}]})),
                    completed_at_ms: Some(3.0),
                },
                super::super::super::types::CodexTranscriptTool {
                    call_id: "notify".into(),
                    name: "send_input".into(),
                    input: Some(json!({"id":"c1","message":"notify","notify_only":true})),
                    started_at_ms: 4.0,
                    output: None,
                    completed_at_ms: None,
                },
            ],
        }];
        let dispatches = extract_dispatches(&parent, &[], "0123456789abcdef0123456789abcdef");
        assert_eq!(dispatches.len(), 3);
        assert_eq!(dispatches[2].work_index, 2);
        assert_eq!(dispatches[2].child_thread_id.as_deref(), Some("c3"));
        assert!(dispatches[1].child_thread_id.is_none());
        assert_ne!(dispatches[0].invocation_id, dispatches[1].invocation_id);
        assert!(!serde_json::to_string(&dispatches)
            .unwrap()
            .contains("private"));
    }
    fn completion(
        turn_id: &str,
        text: Option<&str>,
        interrupted: bool,
    ) -> CodexTranscriptSourceRecord {
        let mut payload =
            json!({"type":if interrupted {"turn_aborted"}else{"task_complete"},"turn_id":turn_id});
        if let Some(text) = text {
            payload["last_agent_message"] = json!(text);
        }
        CodexTranscriptSourceRecord {
            start_offset: 0,
            end_offset: 1,
            record: json!({"type":"event_msg","payload":payload})
                .as_object()
                .unwrap()
                .clone(),
        }
    }
    fn encrypted(turn_id: &str, opaque: &str, result: bool) -> CodexTranscriptSourceRecord {
        source(
            json!({"type":"agent_message","author":"/root","recipient":"/root/worker",
            "internal_chat_message_metadata_passthrough":{"turn_id":turn_id},
            "content":[{"type":"input_text","text":format!("Message Type: {}\nTask name: /root/worker",if result {"FINAL_ANSWER"} else {"NEW_TASK"})},
                {"type":"encrypted_content","encrypted_content":opaque}]}),
        )
    }
    #[test]
    fn sparse_reobservation_preserves_inferred_child_and_native_dispatch_facts() {
        let mut linker = CodexSubagentLinker::new();
        let mut known = spawn("sparse", "private task");
        known.child_thread_id = None;
        known.task_name = Some("/root/worker".into());
        known.child_turn_id = Some("bound-turn".into());
        known.agent_nickname = Some("NativeName".into());
        linker.register_spawns(&[known.clone()]);
        let link = linker
            .resolve_work(&meta(), &turn("bound-turn"), &[], false)
            .unwrap();
        assert_eq!(link.child_thread_id, "child");
        let before = linker.serialize()["spawns"][0].clone();
        assert_eq!(before["resolvedChildThreadId"], "child");
        let sparse = CodexSpawnDescriptor {
            parent_thread_id: known.parent_thread_id.clone(),
            parent_turn_id: known.parent_turn_id.clone(),
            parent_trace_id: known.parent_trace_id.clone(),
            parent_tool_call_id: known.parent_tool_call_id.clone(),
            spawned_at_ms: known.spawned_at_ms,
            ..Default::default()
        };
        linker.register_spawns(&[sparse]);
        let after = linker.serialize()["spawns"][0].clone();
        for key in [
            "resolvedChildThreadId",
            "childTurnId",
            "workFingerprint",
            "agentNickname",
            "dispatchKind",
        ] {
            assert_eq!(after[key], before[key], "sparse observation erased {key}");
        }
    }

    #[test]
    fn restores_legacy_work_prompt_as_hash_without_retaining_plaintext() {
        let mut legacy = serde_json::to_value(spawn("legacy", "unused")).unwrap();
        legacy.as_object_mut().unwrap().remove("workFingerprint");
        legacy["workPrompt"] = json!("legacy private work");
        let mut linker = CodexSubagentLinker::new();
        linker.restore(&json!({"version":1,"spawns":[legacy],"children":[],"bindings":[]}));
        let state = linker.serialize();
        assert_eq!(
            state["spawns"][0]["workFingerprint"],
            work_fingerprint("legacy private work")
        );
        assert!(!state.to_string().contains("legacy private work"));
        assert!(!state.to_string().contains("workPrompt"));
        let input = source(
            json!({"type":"agent_message","content":[{"type":"input_text","text":"legacy private work"}]}),
        );
        assert_eq!(
            linker
                .resolve_work(&meta(), &turn("owned"), &[input], false)
                .unwrap()
                .parent_tool_call_id
                .as_deref(),
            Some("legacy")
        );
    }

    #[test]
    fn encrypted_work_and_final_answer_preserve_binding_across_restore_but_new_input_does_not() {
        for restore in [false, true] {
            let mut linker = CodexSubagentLinker::new();
            linker.register_spawns(&[
                spawn("first", "opaque-first"),
                spawn("second", "opaque-second"),
            ]);
            let original = linker
                .resolve_work(
                    &meta(),
                    &turn("owned"),
                    &[encrypted("owned", "opaque-first", false)],
                    false,
                )
                .unwrap();
            if restore {
                let state = linker.serialize();
                linker = CodexSubagentLinker::new();
                linker.restore(&state);
            }
            let before = linker.serialize();
            assert!(!is_codex_work_input(
                &encrypted("owned", "opaque-result", true),
                "owned"
            ));
            assert_eq!(
                linker.resolve_work(
                    &meta(),
                    &turn("owned"),
                    &[encrypted("owned", "opaque-result", true)],
                    false
                ),
                Some(original.clone())
            );
            assert_eq!(linker.serialize(), before);
            assert!(linker
                .resolve_work(
                    &meta(),
                    &turn("owned"),
                    &[encrypted("owned", "unknown-work", false)],
                    false
                )
                .is_none());
            let direct = source(
                json!({"type":"message","role":"user","content":[{"type":"input_text","text":"opaque-first"}]}),
            );
            assert!(linker
                .resolve_work(&meta(), &turn("owned"), &[direct], false)
                .is_none());
            let second = linker
                .resolve_work(
                    &meta(),
                    &turn("owned"),
                    &[encrypted("owned", "opaque-second", false)],
                    false,
                )
                .unwrap();
            assert_ne!(original.invocation_id, second.invocation_id);
            assert_eq!(second.parent_tool_call_id.as_deref(), Some("second"));
            let text = linker.serialize().to_string();
            for raw in ["opaque-first", "opaque-second", "opaque-result"] {
                assert!(!text.contains(raw));
            }
        }
    }

    #[test]
    fn opaque_conflict_is_rejected_even_with_explicit_turn_but_other_turns_are_scoped_out() {
        let mut linker = CodexSubagentLinker::new();
        let mut first = spawn("first", "opaque-first");
        first.child_turn_id = Some("owned".into());
        linker.register_spawns(&[first, spawn("second", "opaque-second")]);
        assert!(linker
            .resolve_work(
                &meta(),
                &turn("owned"),
                &[
                    encrypted("owned", "opaque-first", false),
                    encrypted("owned", "opaque-second", false)
                ],
                false
            )
            .is_none());
        assert_eq!(
            linker
                .resolve_work(
                    &meta(),
                    &turn("owned"),
                    &[
                        encrypted("owned", "opaque-first", false),
                        encrypted("other", "opaque-second", false)
                    ],
                    false
                )
                .unwrap()
                .parent_tool_call_id
                .as_deref(),
            Some("first")
        );
    }

    #[test]
    fn final_answer_text_quoted_inside_new_task_is_not_a_result_notification() {
        for text in ["Message Type: NEW_TASK\nTask name: /root/worker\nPayload:\nExplain:\nMessage Type: FINAL_ANSWER\nPayload: sample",
            "Review FINAL_ANSWER in this example:\nMessage Type: FINAL_ANSWER\nPayload: sample"] {
            let mut linker=CodexSubagentLinker::new();linker.register_spawns(&[spawn("quoted",text)]);
            let input=source(json!({"type":"agent_message","content":[{"type":"input_text","text":text}]}));
            assert!(is_codex_work_input(&input,"quoted"));
            assert_eq!(linker.resolve_work(&meta(),&turn("quoted"),&[input],false).unwrap().parent_tool_call_id.as_deref(),Some("quoted"));
        }
    }

    #[test]
    fn same_text_direct_user_input_does_not_inherit_creation_or_followup_binding() {
        let mut linker = CodexSubagentLinker::new();
        let mut creation = spawn("create", "repeat");
        creation.dispatch_kind = Some("spawn".into());
        linker.register_spawns(&[creation]);
        let direct = || {
            source(
                json!({"type":"message","role":"user","content":[{"type":"input_text","text":"repeat"}]}),
            )
        };
        let incoming = || {
            source(
                json!({"type":"agent_message","content":[{"type":"input_text","text":"repeat"}]}),
            )
        };
        assert!(linker
            .resolve_work(&meta(), &turn("initial"), &[direct(), incoming()], true)
            .is_none());
        let bound = linker
            .resolve_work(&meta(), &turn("initial"), &[direct()], true)
            .unwrap();
        assert_eq!(bound.parent_tool_call_id.as_deref(), Some("create"));
        assert!(linker
            .resolve_work(&meta(), &turn("later"), &[direct()], false)
            .is_none());
        let event = CodexTranscriptSourceRecord {
            start_offset: 0,
            end_offset: 1,
            record:
                json!({"type":"event_msg","payload":{"type":"user_message","message":"repeat"}})
                    .as_object()
                    .unwrap()
                    .clone(),
        };
        assert!(linker
            .resolve_work(&meta(), &turn("later"), &[event], false)
            .is_none());
    }

    #[test]
    fn creation_fallback_requires_first_owned_turn_and_never_selects_a_future_dispatch() {
        let mut linker = CodexSubagentLinker::new();
        let mut creation = spawn("create", "original");
        creation.dispatch_kind = Some("spawn".into());
        creation.spawned_at_ms = 20.0;
        linker.register_spawns(&[creation]);
        let mut before = turn("before");
        before.started_at_ms = 10.0;
        assert!(linker.resolve_work(&meta(), &before, &[], true).is_none());
        let mut expanded = turn("first");
        expanded.prompt = Some("expanded context original".into());
        assert!(linker
            .resolve_work(&meta(), &expanded, &[], false)
            .is_none());
        assert!(linker.resolve_work(&meta(), &expanded, &[], true).is_some());
        let mut later = turn("later");
        later.prompt = Some("unrelated".into());
        assert!(linker.resolve_work(&meta(), &later, &[], true).is_none());
    }

    #[test]
    fn every_completed_child_turn_needs_exact_result_evidence_before_outcome_is_known() {
        let mut linker = CodexSubagentLinker::new();
        let mut descriptor = spawn("work", "task");
        descriptor.child_turn_id = Some("first".into());
        linker.register_spawns(&[descriptor]);
        let first = turn("first");
        let link = linker.resolve_work(&meta(), &first, &[], false).unwrap();
        linker.register_completed_work_result(
            &link,
            &first,
            &[completion("first", Some("known\n"), false)],
        );
        assert!(linker.get_delegations_for_parent("parent")[0].result_outcome_known);
        let second = turn("second");
        let mut second_link = link.clone();
        second_link.child_turn_id = Some("second".into());
        linker.register_completed_work_result(
            &second_link,
            &second,
            &[completion("second", None, false)],
        );
        let partial = linker.get_delegations_for_parent("parent").pop().unwrap();
        assert!(partial.result_terminal_observed);
        assert!(!partial.result_outcome_known);
        assert_eq!(partial.result_child_turn_ids, ["first", "second"]);
        let state = linker.serialize();
        let mut restored = CodexSubagentLinker::new();
        restored.restore(&state);
        assert!(!restored.get_delegations_for_parent("parent")[0].result_outcome_known);
        restored.register_completed_work_result(
            &second_link,
            &second,
            &[completion("second", Some("second result"), false)],
        );
        assert!(restored.get_delegations_for_parent("parent")[0].result_outcome_known);
        let serialized = restored.serialize().to_string();
        for raw in ["known\\n", "second result", "resultOutcomeKnown"] {
            assert!(!serialized.contains(raw));
        }
    }

    #[test]
    fn unknown_followup_and_identical_results_never_prove_a_unique_receipt() {
        let mut linker = CodexSubagentLinker::new();
        let mut first = spawn("first", "task1");
        first.child_turn_id = Some("t1".into());
        let mut second = spawn("second", "task2");
        second.child_turn_id = Some("t2".into());
        linker.register_spawns(&[first, second]);
        let first = turn("t1");
        let first_link = linker.resolve_work(&meta(), &first, &[], false).unwrap();
        linker.register_completed_work_result(
            &first_link,
            &first,
            &[completion("t1", Some("same"), false)],
        );
        let before = linker.get_delegations_for_parent("parent");
        assert!(before[0].result_outcome_known);
        assert!(!before[1].result_outcome_known);
        assert!(before[1].result_child_turn_ids.is_empty());
        let second = turn("t2");
        let second_link = linker.resolve_work(&meta(), &second, &[], false).unwrap();
        linker.register_completed_work_result(
            &second_link,
            &second,
            &[completion("t2", Some("same"), false)],
        );
        assert_eq!(
            linker
                .get_delegations_for_parent("parent")
                .iter()
                .filter(|s| s.result_fingerprints.contains(&digest("same", 64)))
                .count(),
            2
        );
    }

    #[test]
    fn interrupted_terminal_and_legacy_result_restore_do_not_invent_result_text() {
        let mut linker = CodexSubagentLinker::new();
        let mut descriptor = spawn("abort", "task");
        descriptor.child_turn_id = Some("abort".into());
        linker.register_spawns(&[descriptor]);
        let mut aborted = turn("abort");
        aborted.status = CodexTerminalStatus::Interrupted;
        let link = linker.resolve_work(&meta(), &aborted, &[], false).unwrap();
        linker.register_completed_work_result(
            &link,
            &aborted,
            &[completion("abort", Some("not delivered"), true)],
        );
        let state = linker.serialize();
        assert!(state["completedWorkResults"].as_array().unwrap().is_empty());
        assert!(!state.to_string().contains("not delivered"));
        let mut restored = CodexSubagentLinker::new();
        restored.restore(&state);
        let result = restored.get_delegations_for_parent("parent").pop().unwrap();
        assert!(result.result_outcome_known && result.result_terminal_observed);
        assert!(result.result_fingerprints.is_empty());
        assert_eq!(result.result_child_turn_ids, ["abort"]);
        let mut legacy = state;
        legacy.as_object_mut().unwrap().remove("workTerminals");
        legacy["completedWorkResults"] = json!([{"invocationId":link.invocation_id,"childThreadId":"child","childTurnId":"legacy-complete","fingerprint":digest("legacy result",64)}]);
        let mut restored = CodexSubagentLinker::new();
        restored.restore(&legacy);
        let result = restored.get_delegations_for_parent("parent").pop().unwrap();
        assert!(result.result_terminal_observed && result.result_outcome_known);
        assert_eq!(result.result_child_turn_ids, ["legacy-complete"]);
    }

    #[test]
    fn result_projection_deduplicates_equal_fingerprints_across_distinct_child_turns() {
        let mut linker = CodexSubagentLinker::new();
        let mut descriptor = spawn("work", "task");
        descriptor.child_turn_id = Some("first".into());
        linker.register_spawns(&[descriptor]);
        let first = turn("first");
        let link = linker.resolve_work(&meta(), &first, &[], false).unwrap();
        linker.register_completed_work_result(
            &link,
            &first,
            &[
                completion("first", Some("first delivered result"), false),
                completion("first", Some("分段结果\n"), false),
            ],
        );
        let next = turn("continued");
        let mut continued = link.clone();
        continued.child_turn_id = Some("continued".into());
        linker.register_completed_work_result(
            &continued,
            &next,
            &[completion(
                "continued",
                Some("first delivered result"),
                false,
            )],
        );
        assert_eq!(
            linker.serialize()["completedWorkResults"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
        let projection = linker.get_delegations_for_parent("parent").pop().unwrap();
        assert_eq!(
            projection.result_fingerprints.len(),
            2,
            "projection repeats identical result digest"
        );
        assert_eq!(
            projection
                .result_fingerprints
                .iter()
                .collect::<HashSet<_>>()
                .len(),
            2
        );
        let snapshot = linker.snapshot();
        let state = linker.serialize();
        linker.register_completed_work_result(
            &link,
            &first,
            &[completion("first", Some("first delivered result"), false)],
        );
        assert_eq!(linker.serialize(), state);
        assert_eq!(linker.snapshot(), snapshot);
    }

    #[test]
    fn result_registration_rejects_wrong_turn_child_link_confidence_and_nonterminal_text() {
        let mut linker = CodexSubagentLinker::new();
        let mut descriptor = spawn("work", "task");
        descriptor.child_turn_id = Some("actual".into());
        linker.register_spawns(&[descriptor]);
        let actual = turn("actual");
        let link = linker.resolve_work(&meta(), &actual, &[], false).unwrap();
        linker.register_completed_work_result(
            &link,
            &actual,
            &[completion("other-turn", Some("wrong turn"), false)],
        );
        let mut other_child = actual.clone();
        other_child.session_id = "other-child".into();
        linker.register_completed_work_result(
            &link,
            &other_child,
            &[completion("actual", Some("wrong child"), false)],
        );
        let mut other_link = link.clone();
        other_link.child_turn_id = Some("wrong".into());
        linker.register_completed_work_result(
            &other_link,
            &actual,
            &[completion("actual", Some("wrong link"), false)],
        );
        let mut guessed = link.clone();
        guessed.confidence = CodexSubagentLinkConfidence::TimeOrder;
        linker.register_completed_work_result(
            &guessed,
            &actual,
            &[completion("actual", Some("time guess"), false)],
        );
        let assistant = source(
            json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":"unconfirmed"}]}),
        );
        linker.register_completed_work_result(&link, &actual, &[assistant]);
        let mut interrupted = actual.clone();
        interrupted.status = CodexTerminalStatus::Interrupted;
        linker.register_completed_work_result(
            &link,
            &interrupted,
            &[completion("actual", Some("wrong status"), false)],
        );
        linker.restore(&json!({"version":1,"completedWorkResults":[{"invocationId":link.invocation_id,"childThreadId":"child","childTurnId":"actual","fingerprint":"invalid raw text"}]}));
        assert!(linker.serialize()["completedWorkResults"]
            .as_array()
            .unwrap()
            .is_empty());
        assert!(linker.get_delegations_for_parent("parent")[0]
            .result_fingerprints
            .is_empty());
    }

    #[test]
    fn evicted_terminal_and_result_facts_do_not_leave_phantom_invocation_lookup_results() {
        for terminal in [false, true] {
            let mut linker = CodexSubagentLinker::new();
            let mut descriptor = spawn("retained", "task");
            descriptor.invocation_id = Some("retained-invocation".into());
            linker.register_spawns(&[descriptor]);
            let mut facts = Vec::new();
            for i in 0..=MAX_LINK_DESCRIPTORS {
                let invocation = if i == 0 {
                    "retained-invocation".to_owned()
                } else {
                    format!("other-{i}")
                };
                let mut fact = json!({"invocationId":invocation,"childThreadId":"child","childTurnId":format!("turn-{i}")});
                if terminal {
                    fact["terminalType"] = json!("interrupted");
                } else {
                    fact["fingerprint"] = json!(digest("result", 64));
                }
                facts.push(fact);
            }
            let field = if terminal {
                "workTerminals"
            } else {
                "completedWorkResults"
            };
            let mut state = json!({"version":1});
            state[field] = json!(facts);
            linker.restore(&state);
            assert_eq!(
                linker.serialize()[field].as_array().unwrap().len(),
                MAX_LINK_DESCRIPTORS
            );
            let projection = linker.get_delegations_for_parent("parent").pop().unwrap();
            assert!(!projection.result_terminal_observed && !projection.result_outcome_known);
            assert!(
                projection.result_fingerprints.is_empty()
                    && projection.result_child_turn_ids.is_empty()
            );
        }
    }

    fn parent_tool(input: Value, output: Option<Value>) -> CodexExtractedTranscriptTurn {
        let mut parent = turn("parent-turn");
        parent.session_id = "parent".into();
        parent.steps = vec![CodexTranscriptStep {
            started_at_ms: 1.0,
            response_at_ms: 2.0,
            has_response_evidence: true,
            completed_at_ms: 3.0,
            response_id: None,
            input_messages: None,
            reasoning: Vec::new(),
            token_usage: None,
            final_text: None,
            tools: vec![super::super::super::types::CodexTranscriptTool {
                call_id: "call".into(),
                name: "spawn_agent".into(),
                input: Some(input),
                started_at_ms: 1.0,
                output,
                completed_at_ms: Some(3.0),
            }],
        }];
        parent
    }
    fn creation(
        call: &str,
        at: f64,
        path: Option<&str>,
        child: Option<&str>,
    ) -> CodexSpawnDescriptor {
        CodexSpawnDescriptor {
            parent_thread_id: "parent".into(),
            parent_turn_id: "parent-turn".into(),
            parent_trace_id: "trace".into(),
            parent_tool_call_id: call.into(),
            spawned_at_ms: at,
            task_name: path.map(str::to_owned),
            child_thread_id: child.map(str::to_owned),
            dispatch_kind: Some("spawn".into()),
            ..Default::default()
        }
    }
    fn child_meta(id: &str, at: f64, path: Option<&str>) -> CodexTranscriptMeta {
        let mut child = meta();
        child.thread_id = id.into();
        child.created_at_ms = Some(at);
        child.agent_path = path.map(str::to_owned);
        child
    }
    #[test]
    fn extracts_native_parent_delegation_as_child_prompt_without_opaque_body() {
        use super::super::super::extractor::{extract_codex_partial_turn, ExtractOptions};
        let values = [
            json!({"timestamp":"2026-08-07T09:20:31.534Z","type":"turn_context","payload":{"turn_id":"owned","model":"gpt-test"}}),
            json!({"timestamp":"2026-08-07T09:20:31.538Z","type":"response_item","payload":{"type":"agent_message","author":"/root","recipient":"/root/worker",
                "content":[{"type":"input_text","text":"inspect the delegated file"},{"type":"encrypted_content","encrypted_content":"redacted"}],
                "internal_chat_message_metadata_passthrough":{"turn_id":"owned"}}}),
            json!({"timestamp":"2026-08-07T09:20:42.113Z","type":"response_item","payload":{"type":"message","id":"response-child","role":"assistant","content":[{"type":"output_text","text":"done"}]}}),
            json!({"timestamp":"2026-08-07T09:20:42.255Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}}}),
            json!({"timestamp":"2026-08-07T09:20:42.270Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"owned","last_agent_message":"done"}}),
        ];
        let records: Vec<_> = values
            .into_iter()
            .map(|v| v.as_object().unwrap().clone())
            .collect();
        let result = extract_codex_partial_turn(
            &records,
            Some(&meta()),
            "child",
            "owned",
            &ExtractOptions::default(),
        )
        .unwrap();
        assert_eq!(result.prompt.as_deref(), Some("inspect the delegated file"));
        assert!(result.prompt_ready);
        assert_eq!(
            serde_json::to_value(&result.input_messages).unwrap(),
            json!([{"role":"user","parts":[{"type":"text","content":"inspect the delegated file"}]}])
        );
    }

    #[test]
    fn four_historical_fixture_children_link_by_path_when_children_arrive_first() {
        use super::super::super::extractor::{
            extract_codex_partial_turn, extract_codex_transcript_meta, ExtractOptions,
        };
        let parent=include_str!("../../../tests/fixtures/codex-subagent/rollout-2026-08-07T10-00-00-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl");
        let children=[
            include_str!("../../../tests/fixtures/codex-subagent/rollout-2026-08-07T10-00-04-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl"),
            include_str!("../../../tests/fixtures/codex-subagent/rollout-2026-08-07T10-00-05-cccccccc-cccc-4ccc-8ccc-cccccccccccc.jsonl"),
            include_str!("../../../tests/fixtures/codex-subagent/rollout-2026-08-07T10-00-06-dddddddd-dddd-4ddd-8ddd-dddddddddddd.jsonl"),
            include_str!("../../../tests/fixtures/codex-subagent/rollout-2026-08-07T10-00-07-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.jsonl"),
        ];
        let parse = |text: &str| {
            text.lines()
                .filter(|s| !s.is_empty())
                .map(|line| serde_json::from_str::<serde_json::Map<String, Value>>(line).unwrap())
                .collect::<Vec<_>>()
        };
        let mut linker = CodexSubagentLinker::new();
        for child in children {
            let records = parse(child);
            linker.register_child(&extract_codex_transcript_meta(&records[0]).unwrap());
        }
        let before = linker.snapshot();
        assert_eq!(
            (
                before.detected_children,
                before.detected_spawns,
                before.linked_children,
                before.orphan_children
            ),
            (4, 0, 0, 4)
        );
        let records = parse(parent);
        let meta = extract_codex_transcript_meta(&records[0]).unwrap();
        let parent = extract_codex_partial_turn(
            &records,
            Some(&meta),
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "parent-turn-1",
            &ExtractOptions::default(),
        )
        .unwrap();
        let sources: Vec<_> = records
            .into_iter()
            .enumerate()
            .map(|(i, record)| CodexTranscriptSourceRecord {
                start_offset: i as i64,
                end_offset: i as i64 + 1,
                record,
            })
            .collect();
        linker.register_spawns(&extract_dispatches(&parent, &sources, "parent-trace-id"));
        let after = linker.snapshot();
        assert_eq!(
            (
                after.detected_children,
                after.detected_spawns,
                after.linked_children,
                after.orphan_children
            ),
            (4, 4, 4, 0)
        );
        assert_eq!(
            after
                .links
                .iter()
                .map(|link| link.child_thread_id.as_str())
                .collect::<Vec<_>>(),
            [
                "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
            ]
        );
        for (link, call) in after.links.iter().zip([
            "call-subagent-1",
            "call-subagent-2",
            "call-subagent-3",
            "call-subagent-4",
        ]) {
            assert_eq!(link.parent_tool_call_id.as_deref(), Some(call));
            assert_eq!(link.confidence, CodexSubagentLinkConfidence::AgentPath);
        }
    }

    #[test]
    fn creation_snapshot_prioritizes_explicit_id_then_exact_path_before_time_fallback() {
        let mut linker = CodexSubagentLinker::new();
        linker.register_spawns(&[
            creation(
                "explicit",
                10.0,
                Some("/root/wrong"),
                Some("explicit-child"),
            ),
            creation("fallback", 10.0, None, None),
            creation("exact", 20.0, Some("/root/exact"), None),
        ]);
        linker.register_child(&child_meta("explicit-child", 15.0, Some("/root/actual")));
        linker.register_child(&child_meta("without-path", 25.0, None));
        linker.register_child(&child_meta("exact-child", 30.0, Some("/root/exact")));
        let snapshot = linker.snapshot();
        assert_eq!(snapshot.linked_children, 3);
        let by_id = |id: &str| {
            snapshot
                .links
                .iter()
                .find(|l| l.child_thread_id == id)
                .unwrap()
        };
        assert_eq!(
            by_id("explicit-child").parent_tool_call_id.as_deref(),
            Some("explicit")
        );
        assert_eq!(
            by_id("explicit-child").confidence,
            CodexSubagentLinkConfidence::ExplicitId
        );
        assert_eq!(
            by_id("without-path").parent_tool_call_id.as_deref(),
            Some("fallback")
        );
        assert_eq!(
            by_id("without-path").confidence,
            CodexSubagentLinkConfidence::TimeOrder
        );
        assert_eq!(
            by_id("exact-child").parent_tool_call_id.as_deref(),
            Some("exact")
        );
        assert_eq!(
            by_id("exact-child").confidence,
            CodexSubagentLinkConfidence::AgentPath
        );
        let mut nearest = CodexSubagentLinker::new();
        nearest.register_spawns(&[
            creation("first", 10.0, None, None),
            creation("second", 20.0, None, None),
        ]);
        nearest.register_child(&child_meta("a", 15.0, None));
        nearest.register_child(&child_meta("b", 25.0, None));
        assert_eq!(
            nearest
                .snapshot()
                .links
                .iter()
                .map(|l| l.parent_tool_call_id.as_deref().unwrap())
                .collect::<Vec<_>>(),
            ["first", "second"]
        );
    }

    #[test]
    fn creation_snapshot_duplicate_exact_paths_and_equal_time_ties_remain_orphaned() {
        let mut linker = CodexSubagentLinker::new();
        linker.register_spawns(&[
            creation("one", 10.0, Some("/root/reused"), None),
            creation("two", 20.0, Some("/root/reused"), None),
        ]);
        linker.register_child(&child_meta("ambiguous", 30.0, Some("/root/reused")));
        assert_eq!(
            linker.snapshot().links[0].confidence,
            CodexSubagentLinkConfidence::Orphan
        );
        assert_eq!(
            linker.snapshot().links[0].orphan_reason,
            Some(OrphanReason::AmbiguousAgentPath)
        );
        let mut ties = CodexSubagentLinker::new();
        ties.register_spawns(&[
            creation("one", 10.0, None, None),
            creation("two", 10.0, None, None),
        ]);
        ties.register_child(&child_meta("ambiguous", 30.0, None));
        assert_eq!(
            ties.snapshot().links[0].confidence,
            CodexSubagentLinkConfidence::Orphan
        );
    }

    #[test]
    fn nested_creation_keeps_immediate_parent_at_arbitrary_depth() {
        let mut linker = CodexSubagentLinker::new();
        linker.register_spawns(&[creation("nested", 1.0, None, Some("child"))]);
        let mut nested = meta();
        nested.depth = 20;
        linker.register_child(&nested);
        let link = linker.snapshot().links.pop().unwrap();
        assert_eq!(link.parent_thread_id, "parent");
        assert_eq!(link.child_thread_id, "child");
        assert_eq!(link.confidence, CodexSubagentLinkConfidence::ExplicitId);
    }

    #[test]
    fn rejected_spawn_keeps_audit_intent_without_creation_and_activity_extracts_native_facts() {
        let rejected = parent_tool(
            json!({"task_name":"worker"}),
            Some(json!("collab spawn failed: agent thread limit reached")),
        );
        let rejected = extract_dispatches(&rejected, &[], "trace");
        assert_eq!(rejected.len(), 1);
        assert!(rejected[0].child_thread_id.is_none());
        assert!(rejected[0].dispatch_failed);
        assert_eq!(rejected[0].invocation_id.as_ref().unwrap().len(), 32);
        let mut linker = CodexSubagentLinker::new();
        linker.register_spawns(&rejected);
        assert!(linker
            .resolve_work(&meta(), &turn("owned"), &[], true)
            .is_none());
        let parent = parent_tool(json!({"task_name":"worker"}), None);
        let activity=CodexTranscriptSourceRecord {start_offset:0,end_offset:1,record:json!({"type":"event_msg","payload":{
            "type":"sub_agent_activity","kind":"started","event_id":"call","occurred_at_ms":1234,"agent_thread_id":"native-child","agent_path":"/root/worker"
        }}).as_object().unwrap().clone()};
        let extracted = extract_dispatches(&parent, &[activity], "trace");
        assert_eq!(
            extracted[0].child_thread_id.as_deref(),
            Some("native-child")
        );
        assert_eq!(extracted[0].agent_path.as_deref(), Some("/root/worker"));
        assert_eq!(extracted[0].spawned_at_ms, 1234.0);
        assert_eq!(extracted[0].parent_thread_id, "parent");
        assert_eq!(extracted[0].parent_turn_id, "parent-turn");
        assert_eq!(extracted[0].parent_trace_id, "trace");
        assert_eq!(extracted[0].parent_tool_call_id, "call");
    }
    fn started_activity(child: &str, turn: Option<&str>) -> CodexTranscriptSourceRecord {
        let mut payload = json!({"type":"sub_agent_activity","kind":"started","event_id":"call","agent_thread_id":child});
        if let Some(turn) = turn {
            payload["turn_id"] = json!(turn);
        }
        CodexTranscriptSourceRecord {
            start_offset: 0,
            end_offset: 1,
            record: json!({"type":"event_msg","payload":payload})
                .as_object()
                .unwrap()
                .clone(),
        }
    }
    fn plain_work(turn: &str, text: &str) -> CodexTranscriptSourceRecord {
        source(
            json!({"type":"agent_message","author":"/root","recipient":"/root/worker",
            "internal_chat_message_metadata_passthrough":{"turn_id":turn},"content":[{"type":"input_text","text":text}]}),
        )
    }
    #[test]
    fn native_agent_id_result_reserves_tool_and_invocation_before_acceptance_and_projects_nickname()
    {
        let mut parent = parent_tool(json!({"message":"work"}), None);
        let pending = extract_dispatches(&parent, &[], "trace").pop().unwrap();
        parent.steps[0].tools[0].output = Some(json!({"agent_id":"child","nickname":"Ada"}));
        let accepted = extract_dispatches(&parent, &[], "trace").pop().unwrap();
        assert_eq!(pending.invocation_id, accepted.invocation_id);
        assert_eq!(pending.parent_tool_span_id, accepted.parent_tool_span_id);
        assert_eq!(accepted.agent_nickname.as_deref(), Some("Ada"));
        assert!(accepted.agent_path.is_none());
        let mut linker = CodexSubagentLinker::new();
        linker.register_spawns(&[pending, accepted.clone()]);
        linker.register_child(&child_meta("child", 30.0, None));
        assert_eq!(linker.serialize()["spawns"].as_array().unwrap().len(), 1);
        let snapshot = linker.snapshot();
        assert_eq!(
            snapshot.links[0].confidence,
            CodexSubagentLinkConfidence::ExplicitId
        );
        assert_eq!(
            snapshot.links[0].parent_tool_span_id,
            accepted.parent_tool_span_id
        );
        assert_eq!(
            linker.get_delegations_for_parent("parent")[0]
                .agent_nickname
                .as_deref(),
            Some("Ada")
        );
    }
    #[test]
    fn native_child_nickname_projection_supports_explicit_path_and_bound_lookup_across_restore() {
        for kind in ["explicit", "path", "bound"] {
            let mut descriptor = creation("named", 1.0, Some("named"), None);
            if kind == "explicit" {
                descriptor.child_thread_id = Some("child".into());
            }
            if kind == "bound" {
                descriptor.resolved_child_thread_id = Some("child".into());
            }
            let mut linker = CodexSubagentLinker::new();
            linker.register_spawns(&[descriptor]);
            let mut child = child_meta("child", 30.0, Some("/root/named"));
            child.agent_nickname = Some("Newton".into());
            linker.register_child(&child);
            let projection = linker.get_delegations_for_parent("parent").pop().unwrap();
            assert_eq!(
                projection.child_thread_id.as_deref(),
                Some("child"),
                "{kind}"
            );
            assert_eq!(
                projection.agent_nickname.as_deref(),
                Some("Newton"),
                "{kind}"
            );
            assert!(
                linker.serialize()["spawns"][0]["agentNickname"].is_null(),
                "{kind} mutated native lineage"
            );
            let mut restored = CodexSubagentLinker::new();
            restored.restore(&linker.serialize());
            let recovered = restored.get_delegations_for_parent("parent").pop().unwrap();
            assert_eq!(recovered.child_thread_id, projection.child_thread_id);
            assert_eq!(recovered.agent_nickname, projection.agent_nickname);
            assert_eq!(recovered.invocation_id, projection.invocation_id);
        }
    }
    #[test]
    fn duplicate_child_paths_do_not_guess_a_peer_nickname() {
        let mut linker = CodexSubagentLinker::new();
        linker.register_spawns(&[creation("ambiguous", 1.0, Some("named"), None)]);
        for (id, name) in [("first", "Newton"), ("second", "Curie")] {
            let mut child = child_meta(id, 30.0, Some("/root/named"));
            child.agent_nickname = Some(name.into());
            linker.register_child(&child);
        }
        let projection = linker.get_delegations_for_parent("parent").pop().unwrap();
        assert!(projection.child_thread_id.is_none());
        assert!(projection.agent_nickname.is_none());
    }
    #[test]
    fn batch_work_ids_are_stable_per_position_and_share_the_actual_dispatch_tool() {
        let mut parent = parent_tool(
            json!({"agents":[{"task_name":"one","message":"private one"},{"task_name":"two","message":"private two"}]}),
            None,
        );
        let pending = extract_dispatches(&parent, &[], "trace");
        parent.steps[0].tools[0].output =
            Some(json!({"agents":[{"agent_id":"one"},{"agent_id":"two"}]}));
        let accepted = extract_dispatches(&parent, &[], "trace");
        assert_eq!(pending.len(), 2);
        assert_eq!(accepted.len(), 2);
        assert_ne!(accepted[0].invocation_id, accepted[1].invocation_id);
        assert_eq!(
            accepted[0].parent_tool_span_id,
            accepted[1].parent_tool_span_id
        );
        assert!(accepted[0].parent_tool_span_id.is_some());
        for i in 0..2 {
            assert_eq!(accepted[i].work_index, i);
            assert_eq!(pending[i].invocation_id, accepted[i].invocation_id);
            assert_eq!(
                pending[i].parent_tool_span_id,
                accepted[i].parent_tool_span_id
            );
        }
        assert_eq!(accepted[0].child_thread_id.as_deref(), Some("one"));
        assert_eq!(accepted[1].child_thread_id.as_deref(), Some("two"));
        assert!(!serde_json::to_string(&accepted)
            .unwrap()
            .contains("private"));
    }
    #[test]
    fn task_path_multiple_activities_and_repeated_activity_keep_native_work_cardinality() {
        let parent = parent_tool(
            json!({"message":"work"}),
            Some(json!({"task_path":"/root/worker"})),
        );
        assert_eq!(
            extract_dispatches(&parent, &[], "trace")[0]
                .agent_path
                .as_deref(),
            Some("/root/worker")
        );
        let activities = [
            started_activity("child-a", None),
            started_activity("child-b", None),
        ];
        let descriptors = extract_dispatches(&parent, &activities, "trace");
        assert_eq!(
            descriptors
                .iter()
                .map(|d| d.child_thread_id.as_deref())
                .collect::<Vec<_>>(),
            [Some("child-a"), Some("child-b")]
        );
        let parent = parent_tool(json!({"message":"work"}), None);
        let repeated = started_activity("child", None);
        let descriptors = extract_dispatches(&parent, &[repeated.clone(), repeated], "trace");
        assert_eq!(descriptors.len(), 1);
        assert_eq!(descriptors[0].child_thread_id.as_deref(), Some("child"));
    }
    #[test]
    fn real_followup_and_input_get_new_invocations_while_queries_notifications_and_cancel_are_excluded(
    ) {
        let mut parent = parent_tool(json!({"target":"/root/reused","message":"new work"}), None);
        parent.steps[0].tools[0].name = "followup_task".into();
        let followup = extract_dispatches(&parent, &[], "trace").pop().unwrap();
        assert_eq!(followup.dispatch_kind.as_deref(), Some("followup"));
        assert_eq!(followup.agent_path.as_deref(), Some("/root/reused"));
        assert_eq!(followup.work_fingerprint.as_ref().unwrap().len(), 64);
        parent.steps[0].tools[0].name = "send_input".into();
        parent.steps[0].tools[0].input = Some(json!({"id":"reused","message":"next work"}));
        let input = extract_dispatches(&parent, &[], "trace").pop().unwrap();
        assert_eq!(input.dispatch_kind.as_deref(), Some("input"));
        assert_eq!(input.child_thread_id.as_deref(), Some("reused"));
        for flag in ["cancel", "notification", "notify_only", "notification_only"] {
            let mut args = json!({"id":"reused","message":"notice"});
            args[flag] = json!(true);
            parent.steps[0].tools[0].input = Some(args);
            assert!(
                extract_dispatches(&parent, &[], "trace").is_empty(),
                "{flag}"
            );
        }
        for name in ["wait", "send_message", "send_message_to_thread"] {
            parent.steps[0].tools[0].name = name.into();
            parent.steps[0].tools[0].input = Some(json!({"id":"reused","message":"notice"}));
            assert!(
                extract_dispatches(&parent, &[], "trace").is_empty(),
                "{name}"
            );
        }
        parent.steps[0].tools[0].name = "followup_task".into();
        parent.steps[0].tools[0].input = Some(json!({"target":"/root/reused"}));
        assert!(extract_dispatches(&parent, &[], "trace").is_empty());
        parent.steps[0].tools[0].call_id = "new-call".into();
        parent.steps[0].tools[0].input =
            Some(json!({"target":"/root/reused","message":"new work"}));
        assert_ne!(
            extract_dispatches(&parent, &[], "trace")[0].invocation_id,
            followup.invocation_id
        );
    }
    #[test]
    fn reused_plain_work_binds_by_received_input_and_continues_without_new_input_after_restore() {
        let mut linker = CodexSubagentLinker::new();
        let mut first = spawn("first", "first work");
        first.dispatch_kind = Some("spawn".into());
        linker.register_spawns(&[first, spawn("second", "second work")]);
        let original = linker
            .resolve_work(
                &meta(),
                &turn("first-turn"),
                &[plain_work("first-turn", "first work")],
                false,
            )
            .unwrap();
        assert_eq!(original.parent_tool_call_id.as_deref(), Some("first"));
        let second = linker
            .resolve_work(
                &meta(),
                &turn("second-turn"),
                &[plain_work("second-turn", "second work")],
                false,
            )
            .unwrap();
        assert_eq!(second.parent_tool_call_id.as_deref(), Some("second"));
        assert_ne!(original.invocation_id, second.invocation_id);
        let mut bare = turn("bare");
        bare.prompt = Some("first work".into());
        assert!(linker.resolve_work(&meta(), &bare, &[], false).is_none());
        // One uniquely established invocation can continue on its next native
        // turn; two prior works in the same session cannot establish that.
        let mut single = CodexSubagentLinker::new();
        single.register_spawns(&[spawn("only", "work")]);
        let owned = single
            .resolve_work(
                &meta(),
                &turn("owned"),
                &[plain_work("owned", "work")],
                false,
            )
            .unwrap();
        let mut restored = CodexSubagentLinker::new();
        restored.restore(&single.serialize());
        restored.restore(&Value::Null);
        assert_eq!(
            restored.resolve_work(&meta(), &turn("owned"), &[], false),
            Some(owned.clone())
        );
        let continuation = restored
            .resolve_work(&meta(), &turn("continuation"), &[], false)
            .unwrap();
        assert_eq!(continuation.invocation_id, owned.invocation_id);
        assert_eq!(continuation.parent_tool_call_id, owned.parent_tool_call_id);
        assert!(linker
            .resolve_work(&meta(), &turn("ambiguous-continuation"), &[], false)
            .is_none());
    }
    #[test]
    fn explicit_child_turn_evidence_selects_unique_work_without_guessing_from_bare_prompt() {
        let mut linker = CodexSubagentLinker::new();
        let first = spawn("first", "same");
        let mut second = spawn("second", "same");
        second.child_turn_id = Some("explicit".into());
        linker.register_spawns(&[first, second]);
        let mut bare = turn("bare");
        bare.prompt = Some("same".into());
        assert!(linker.resolve_work(&meta(), &bare, &[], false).is_none());
        let mut explicit = turn("explicit");
        explicit.prompt = Some("same".into());
        assert_eq!(
            linker
                .resolve_work(&meta(), &explicit, &[], false)
                .unwrap()
                .parent_tool_call_id
                .as_deref(),
            Some("second")
        );
    }
    #[test]
    fn simultaneous_new_task_and_opaque_final_answer_share_one_native_work_fingerprint() {
        let mut linker = CodexSubagentLinker::new();
        linker.register_spawns(&[spawn("incoming", "opaque-incoming")]);
        let work = encrypted("owned", "opaque-incoming", false);
        let result = encrypted("owned", "different-result", true);
        assert!(is_codex_work_input(&work, "owned"));
        assert!(!is_codex_work_input(&result, "owned"));
        assert_eq!(
            linker
                .resolve_work(&meta(), &turn("owned"), &[work, result], false)
                .unwrap()
                .parent_tool_call_id
                .as_deref(),
            Some("incoming")
        );
        let state = linker.serialize();
        assert_eq!(state["spawns"].as_array().unwrap().len(), 1);
        assert_eq!(state["bindings"].as_array().unwrap().len(), 1);
    }
    #[test]
    fn injected_context_is_distinct_from_work_but_unclosed_mixed_and_unwrapped_user_text_are_not() {
        for header in [
            "# AGENTS.md instructions for /workspace",
            "# AGENTS.md instructions",
        ] {
            let mut linker = CodexSubagentLinker::new();
            linker.register_spawns(&[spawn("isolated", "opaque-work")]);
            let injected = |turn: &str| {
                source(json!({"type":"message","role":"user",
                "internal_chat_message_metadata_passthrough":{"turn_id":turn},
                "content":[{"type":"input_text","text":format!("{header}\n<INSTRUCTIONS>\nFollow conventions.\n</INSTRUCTIONS>")},
                    {"type":"input_text","text":"<environment_context>\n<cwd>/workspace</cwd>\n</environment_context>"}]}))
            };
            assert_eq!(
                linker
                    .resolve_work(
                        &meta(),
                        &turn("initial"),
                        &[
                            injected("initial"),
                            encrypted("initial", "opaque-work", false)
                        ],
                        false
                    )
                    .unwrap()
                    .parent_tool_call_id
                    .as_deref(),
                Some("isolated")
            );
            let direct = source(
                json!({"type":"message","role":"user","content":[{"type":"input_text","text":"opaque-work"}]}),
            );
            assert!(linker
                .resolve_work(&meta(), &turn("direct"), &[direct], false)
                .is_none());
            let mut unclosed = injected("unclosed");
            unclosed.record.get_mut("payload").unwrap()["content"][0]["text"] =
                json!(format!("{header}\n<INSTRUCTIONS>not closed"));
            assert!(linker
                .resolve_work(
                    &meta(),
                    &turn("unclosed"),
                    &[unclosed, encrypted("unclosed", "opaque-work", false)],
                    false
                )
                .is_none());
            let mut mixed = injected("mixed");
            mixed.record.get_mut("payload").unwrap()["content"]
                .as_array_mut()
                .unwrap()
                .push(json!({"type":"input_text","text":"opaque-work"}));
            assert!(linker
                .resolve_work(
                    &meta(),
                    &turn("mixed"),
                    &[mixed, encrypted("mixed", "opaque-work", false)],
                    true
                )
                .is_none());
            let unwrapped = source(
                json!({"type":"message","role":"user","content":[{"type":"input_text","text":format!("{header}\nopaque-work")}]}),
            );
            assert!(linker
                .resolve_work(
                    &meta(),
                    &turn("unwrapped"),
                    &[unwrapped, encrypted("unwrapped", "opaque-work", false)],
                    false
                )
                .is_none());
        }
    }
    #[test]
    fn batch_activity_correlates_by_child_identity_when_native_records_arrive_out_of_order() {
        let parent = parent_tool(
            json!({"agents":[{"message":"work A"},{"message":"work B"}]}),
            Some(json!({"agents":[{"agent_id":"A"},{"agent_id":"B"}]})),
        );
        let descriptors = extract_dispatches(
            &parent,
            &[
                started_activity("B", Some("Bt")),
                started_activity("A", Some("At")),
            ],
            "trace",
        );
        assert_eq!(
            descriptors
                .iter()
                .map(|d| (
                    d.work_index,
                    d.child_thread_id.as_deref(),
                    d.child_turn_id.as_deref()
                ))
                .collect::<Vec<_>>(),
            [(0, Some("A"), Some("At")), (1, Some("B"), Some("Bt"))]
        );
        let mut linker = CodexSubagentLinker::new();
        linker.register_spawns(&descriptors);
        let meta = child_meta("A", 30.0, None);
        let mut owned = turn("At");
        owned.session_id = "A".into();
        owned.prompt = Some("work A".into());
        assert_eq!(
            linker
                .resolve_work(&meta, &owned, &[], false)
                .unwrap()
                .invocation_id,
            descriptors[0].invocation_id
        );
    }
    #[test]
    fn uncorrelated_batch_activity_does_not_guess_and_contradictory_single_child_is_rejected() {
        let parent = parent_tool(
            json!({"agents":[{"message":"work A"},{"message":"work B"}]}),
            None,
        );
        let sources = [started_activity("B", None), started_activity("A", None)];
        let descriptors = extract_dispatches(&parent, &sources, "trace");
        assert_eq!(descriptors.len(), 2);
        assert!(descriptors.iter().all(|d| d.child_thread_id.is_none()));
        let parent = parent_tool(json!({"message":"work A"}), Some(json!({"agent_id":"A"})));
        let conflicted = extract_dispatches(&parent, &sources[..1], "trace");
        assert!(conflicted[0].association_conflict);
        let mut linker = CodexSubagentLinker::new();
        linker.register_spawns(&conflicted);
        let meta = child_meta("A", 30.0, None);
        let mut owned = turn("owned");
        owned.session_id = "A".into();
        assert!(linker.resolve_work(&meta, &owned, &[], true).is_none());
    }

    #[test]
    fn parent_scoped_projection_enriches_only_unique_path_and_does_not_mutate_lineage() {
        let mut linker = CodexSubagentLinker::new();
        let named = creation("path", 1.0, Some("known"), None);
        let mut other = creation("other", 1.0, None, Some("other-child"));
        other.parent_thread_id = "other-parent".into();
        linker.register_spawns(&[named, other]);
        linker.register_child(&child_meta("known-child", 30.0, Some("/root/known")));
        let mut projection = linker.get_delegations_for_parent("parent");
        assert_eq!(projection.len(), 1);
        assert_eq!(projection[0].parent_tool_call_id, "path");
        assert_eq!(
            projection[0].child_thread_id.as_deref(),
            Some("known-child")
        );
        projection[0].child_thread_id = Some("caller-mutation".into());
        assert_eq!(
            linker.get_delegations_for_parent("parent")[0]
                .child_thread_id
                .as_deref(),
            Some("known-child")
        );
        let stored = linker.serialize()["spawns"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["parentToolCallId"] == "path")
            .unwrap()
            .clone();
        assert!(stored["childThreadId"].is_null());
        assert!(stored["resolvedChildThreadId"].is_null());
        linker.register_child(&child_meta("duplicate-child", 31.0, Some("/root/known")));
        assert!(linker.get_delegations_for_parent("parent")[0]
            .child_thread_id
            .is_none());
    }
    #[test]
    fn repeated_creation_paths_do_not_infer_a_result_peer_from_one_observed_child() {
        let mut linker = CodexSubagentLinker::new();
        linker.register_spawns(&[
            creation("one", 1.0, Some("same"), None),
            creation("two", 2.0, Some("/root/same"), None),
        ]);
        linker.register_child(&child_meta("only-child", 30.0, Some("/root/same")));
        let projection = linker.get_delegations_for_parent("parent");
        assert_eq!(projection.len(), 2);
        assert!(projection.iter().all(|s| s.child_thread_id.is_none()));
    }
    #[test]
    fn path_reuse_never_guesses_followup_or_input_peer_before_or_after_restore() {
        for kind in ["followup", "input"] {
            let mut linker = CodexSubagentLinker::new();
            let old = creation("old-creation", 1.0, Some("same"), Some("old-child"));
            let new = creation("new-creation", 2.0, Some("/root/same"), None);
            let mut pending = creation("new-work", 3.0, None, None);
            pending.agent_path = Some("/root/same".into());
            pending.dispatch_kind = Some(kind.into());
            let mut explicit = pending.clone();
            explicit.parent_tool_call_id = "explicit-work".into();
            explicit.child_thread_id = Some("new-child".into());
            linker.register_spawns(&[old, new, pending, explicit]);
            linker.register_child(&child_meta("old-child", 30.0, Some("/root/same")));
            let saved = linker.serialize();
            let mut restored = CodexSubagentLinker::new();
            restored.restore(&saved);
            for candidate in [&mut linker, &mut restored] {
                let lookup = candidate.get_delegations_for_parent("parent");
                let pending = lookup
                    .iter()
                    .find(|d| d.parent_tool_call_id == "new-work")
                    .unwrap();
                let invocation = pending.invocation_id.clone();
                assert!(pending.child_thread_id.is_none(), "{kind}");
                assert_eq!(
                    lookup
                        .iter()
                        .find(|d| d.parent_tool_call_id == "explicit-work")
                        .unwrap()
                        .child_thread_id
                        .as_deref(),
                    Some("new-child")
                );
                candidate.register_child(&child_meta("new-child", 31.0, Some("/root/same")));
                let lookup = candidate.get_delegations_for_parent("parent");
                let pending = lookup
                    .iter()
                    .find(|d| d.parent_tool_call_id == "new-work")
                    .unwrap();
                assert_eq!(pending.invocation_id, invocation);
                assert!(
                    pending.child_thread_id.is_none(),
                    "{kind} guessed after path reuse"
                );
            }
        }
    }

    #[test]
    fn unique_path_followup_resolves_with_zero_or_one_creation_records() {
        for creations in [0, 1] {
            let mut linker = CodexSubagentLinker::new();
            if creations == 1 {
                linker.register_spawns(&[creation("creation", 1.0, Some("same"), None)]);
            }
            let mut descriptor = creation("work", 2.0, None, None);
            descriptor.agent_path = Some("/root/same".into());
            descriptor.dispatch_kind = Some("followup".into());
            linker.register_spawns(&[descriptor]);
            linker.register_child(&child_meta("known-child", 30.0, Some("/root/same")));
            assert_eq!(
                linker
                    .get_delegations_for_parent("parent")
                    .iter()
                    .find(|d| d.parent_tool_call_id == "work")
                    .unwrap()
                    .child_thread_id
                    .as_deref(),
                Some("known-child"),
                "{creations}"
            );
        }
    }
    #[test]
    fn unrelated_global_state_does_not_affect_owned_work_and_peer_lookup() {
        let mut linker = CodexSubagentLinker::new();
        linker.register_spawns(&[spawn("mine", "work")]);
        for i in 0..50 {
            let mut unrelated = creation(
                &format!("other-call-{i}"),
                1.0,
                None,
                Some(&format!("other-child-{i}")),
            );
            unrelated.parent_thread_id = format!("other-parent-{i}");
            linker.register_spawns(&[unrelated]);
        }
        let projection = linker.get_delegations_for_parent("parent");
        assert_eq!(projection.len(), 1);
        assert_eq!(projection[0].parent_tool_call_id, "mine");
        let work = linker
            .resolve_work(
                &meta(),
                &turn("owned"),
                &[plain_work("owned", "work")],
                false,
            )
            .unwrap();
        assert_eq!(work.parent_tool_call_id.as_deref(), Some("mine"));
        // This verifies isolation, not the absence of global enumeration. The
        // latter requires an index/counter implementation and remains pending.
    }
    #[test]
    fn repeated_native_facts_and_restore_preserve_semantic_snapshots_until_new_evidence() {
        let mut linker = CodexSubagentLinker::new();
        let descriptor = creation("mine", 1.0, None, Some("child"));
        let child = meta();
        linker.register_spawns(std::slice::from_ref(&descriptor));
        linker.register_child(&child);
        let snapshot = linker.snapshot();
        let state = linker.serialize();
        linker.register_spawns(std::slice::from_ref(&descriptor));
        linker.register_child(&child);
        linker.restore(&state);
        assert_eq!(linker.snapshot(), snapshot);
        assert_eq!(linker.serialize(), state);
        let mut changed = descriptor;
        changed.child_turn_id = Some("new-evidence".into());
        linker.register_spawns(&[changed]);
        assert_ne!(linker.serialize(), state);
        assert!(linker
            .resolve_work(&child, &turn("new-evidence"), &[], false)
            .is_some());
        // Rust returns owned values. These assertions do not claim that JS
        // reference-identity cache performance has been validated.
    }
    #[test]
    fn restored_path_binding_survives_until_native_spawn_eviction_removes_its_peer() {
        let mut linker = CodexSubagentLinker::new();
        let mut descriptor = creation("path", 1.0, Some("restored"), None);
        descriptor.work_fingerprint = Some(work_fingerprint("work"));
        linker.register_spawns(&[descriptor]);
        let child = child_meta("owned", 30.0, Some("/root/restored"));
        let mut owned = turn("owned-turn");
        owned.session_id = "owned".into();
        owned.prompt = Some("work".into());
        let first = linker
            .resolve_work(&child, &owned, &[plain_work("owned-turn", "work")], false)
            .unwrap();
        let mut restored = CodexSubagentLinker::new();
        restored.restore(&linker.serialize());
        assert_eq!(
            restored.get_delegations_for_parent("parent")[0]
                .child_thread_id
                .as_deref(),
            Some("owned")
        );
        owned.prompt = None;
        assert_eq!(
            restored.resolve_work(&child, &owned, &[], false),
            Some(first)
        );
        let fillers: Vec<_> = (0..MAX_LINK_DESCRIPTORS)
            .map(|i| {
                let mut filler = creation(
                    &format!("fill-{i}"),
                    1.0,
                    None,
                    Some(&format!("filler-{i}")),
                );
                filler.parent_thread_id = "filler".into();
                filler
            })
            .collect();
        restored.register_spawns(&fillers);
        assert!(restored.get_delegations_for_parent("parent").is_empty());
        assert!(restored
            .resolve_work(&child, &owned, &[plain_work("owned-turn", "work")], false)
            .is_none());
    }
    #[test]
    fn resolved_path_work_preserves_native_confidence_when_later_creation_makes_path_ambiguous() {
        let mut linker = CodexSubagentLinker::new();
        let mut descriptor = creation("first", 1.0, Some("same"), None);
        descriptor.work_fingerprint = Some(work_fingerprint("first work"));
        linker.register_spawns(&[descriptor]);
        let child = child_meta("child", 30.0, Some("/root/same"));
        let initial = linker
            .resolve_work(
                &child,
                &turn("owned"),
                &[plain_work("owned", "first work")],
                false,
            )
            .unwrap();
        assert_eq!(initial.confidence, CodexSubagentLinkConfidence::AgentPath);
        let stored = linker.serialize()["spawns"][0].clone();
        assert_eq!(stored["resolvedChildThreadId"], "child");
        assert!(stored["childThreadId"].is_null());
        assert_eq!(
            linker.get_delegations_for_parent("parent")[0]
                .child_thread_id
                .as_deref(),
            Some("child")
        );
        assert_eq!(
            linker.snapshot().links[0].confidence,
            CodexSubagentLinkConfidence::AgentPath
        );
        let mut later = creation("second", 2.0, Some("same"), None);
        later.work_fingerprint = Some(work_fingerprint("second work"));
        linker.register_spawns(&[later]);
        assert_eq!(
            linker.snapshot().links[0].confidence,
            CodexSubagentLinkConfidence::Orphan
        );
        assert_eq!(
            linker.snapshot().links[0].orphan_reason,
            Some(OrphanReason::AmbiguousAgentPath)
        );
        assert_eq!(
            linker.resolve_work(&child, &turn("owned"), &[], false),
            Some(initial)
        );
    }
    #[test]
    fn agent_id_result_peer_uses_its_exact_child_metadata_even_when_paths_are_duplicated() {
        let parent = parent_tool(
            json!({"message":"work","task_name":"relative-name"}),
            Some(json!({"agent_id":"native-child","nickname":"Beta"})),
        );
        let mut linker = CodexSubagentLinker::new();
        linker.register_spawns(&extract_dispatches(&parent, &[], "trace"));
        let child = child_meta("native-child", 30.0, Some("/root/child"));
        linker.register_child(&child);
        linker.register_child(&child_meta("another-child", 31.0, Some("/root/child")));
        let mut owned = turn("owned");
        owned.session_id = "native-child".into();
        let link = linker
            .resolve_work(&child, &owned, &[plain_work("owned", "work")], false)
            .unwrap();
        linker.register_completed_work_result(
            &link,
            &owned,
            &[completion("owned", Some("delivered"), false)],
        );
        let projection = linker.get_delegations_for_parent("parent").pop().unwrap();
        assert_eq!(projection.child_thread_id.as_deref(), Some("native-child"));
        assert_eq!(projection.agent_path.as_deref(), Some("/root/child"));
        assert_eq!(projection.result_fingerprints, [digest("delivered", 64)]);
        assert!(linker.serialize()["spawns"][0]["agentPath"].is_null());
    }
    #[test]
    fn interrupted_initial_work_does_not_claim_exact_completed_followup_result() {
        let mut linker = CodexSubagentLinker::new();
        let mut initial = spawn("initial", "task1");
        initial.dispatch_kind = Some("spawn".into());
        initial.child_turn_id = Some("initial-turn".into());
        let mut followup = spawn("followup", "task2");
        followup.child_turn_id = Some("followup-turn".into());
        linker.register_spawns(&[initial, followup]);
        let mut initial = turn("initial-turn");
        initial.status = CodexTerminalStatus::Interrupted;
        let first = linker.resolve_work(&meta(), &initial, &[], false).unwrap();
        linker.register_completed_work_result(
            &first,
            &initial,
            &[completion("initial-turn", None, true)],
        );
        let followup = turn("followup-turn");
        let second = linker.resolve_work(&meta(), &followup, &[], false).unwrap();
        linker.register_completed_work_result(
            &second,
            &followup,
            &[completion(
                "followup-turn",
                Some("Exact delivered result\n"),
                false,
            )],
        );
        let projection = linker.get_delegations_for_parent("parent");
        assert!(projection[0].result_fingerprints.is_empty());
        assert!(projection[0].result_terminal_observed && projection[0].result_outcome_known);
        assert_eq!(projection[0].result_child_turn_ids, ["initial-turn"]);
        assert_eq!(
            projection[1].result_fingerprints,
            [digest("Exact delivered result\n", 64)]
        );
        assert!(projection[1].result_terminal_observed && projection[1].result_outcome_known);
        assert_eq!(projection[1].result_child_turn_ids, ["followup-turn"]);
        assert_ne!(
            digest("Exact delivered result\n", 64),
            digest("Exact delivered result", 64)
        );
        let terminals = linker.serialize()["workTerminals"]
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(terminals.len(), 2);
        assert_eq!(terminals[0]["invocationId"], json!(first.invocation_id));
        assert_eq!(terminals[0]["terminalType"], "interrupted");
        assert_eq!(terminals[1]["invocationId"], json!(second.invocation_id));
        assert_eq!(terminals[1]["terminalType"], "completed");
    }
    #[test]
    fn real_completion_without_final_text_records_terminal_but_keeps_outcome_unknown() {
        let mut linker = CodexSubagentLinker::new();
        let mut descriptor = spawn("work", "task");
        descriptor.child_turn_id = Some("actual".into());
        linker.register_spawns(&[descriptor]);
        let actual = turn("actual");
        let link = linker.resolve_work(&meta(), &actual, &[], false).unwrap();
        let before = linker.snapshot();
        linker.register_completed_work_result(&link, &actual, &[completion("actual", None, false)]);
        assert_eq!(linker.snapshot(), before);
        let projection = linker.get_delegations_for_parent("parent").pop().unwrap();
        assert!(projection.result_terminal_observed);
        assert!(!projection.result_outcome_known);
        assert_eq!(projection.result_child_turn_ids, ["actual"]);
        assert!(projection.result_fingerprints.is_empty());
        let state = linker.serialize();
        assert!(state["completedWorkResults"].as_array().unwrap().is_empty());
        assert_eq!(state["workTerminals"][0]["childTurnId"], "actual");
        assert_eq!(state["workTerminals"][0]["terminalType"], "completed");
    }
    #[test]
    fn time_tie_stays_ambiguous_after_unique_preceding_candidate_is_consumed() {
        let mut linker = CodexSubagentLinker::new();
        linker.register_spawns(&[
            creation("old", 10.0, None, None),
            creation("tie-a", 20.0, None, None),
            creation("tie-b", 20.0, None, None),
        ]);
        linker.register_child(&child_meta("earlier", 15.0, None));
        linker.register_child(&child_meta("tied", 25.0, None));
        let links = linker.snapshot().links;
        assert_eq!(links[0].child_thread_id, "earlier");
        assert_eq!(links[0].parent_tool_call_id.as_deref(), Some("old"));
        assert_eq!(links[0].confidence, CodexSubagentLinkConfidence::TimeOrder);
        assert_eq!(links[1].child_thread_id, "tied");
        assert_eq!(links[1].confidence, CodexSubagentLinkConfidence::Orphan);
        assert_eq!(links[1].orphan_reason, Some(OrphanReason::NoCandidate));
    }
    #[test]
    fn sparse_observation_never_retracts_native_failure_or_association_conflict() {
        for conflict in [false, true] {
            let mut linker = CodexSubagentLinker::new();
            let mut observed = creation("failed", 1.0, Some("worker"), Some("child"));
            observed.dispatch_failed = !conflict;
            observed.association_conflict = conflict;
            linker.register_spawns(std::slice::from_ref(&observed));
            let sparse = creation("failed", 1.0, None, None);
            linker.register_spawns(&[sparse]);
            let stored = linker.serialize()["spawns"][0].clone();
            assert_eq!(stored["dispatchFailed"], json!(!conflict));
            assert_eq!(stored["associationConflict"], json!(conflict));
            assert_eq!(linker.snapshot().detected_spawns, 0);
            assert!(linker
                .resolve_work(&meta(), &turn("owned"), &[], true)
                .is_none());
        }
    }
    #[test]
    fn legacy_prompt_restore_prefers_existing_hash_and_discards_nonstring_legacy_input() {
        let mut old = serde_json::to_value(spawn("legacy-priority", "established")).unwrap();
        old["workPrompt"] = json!("different private legacy body");
        let mut linker = CodexSubagentLinker::new();
        linker.restore(&json!({"version":1,"spawns":[old]}));
        let state = linker.serialize();
        assert_eq!(
            state["spawns"][0]["workFingerprint"],
            work_fingerprint("established")
        );
        assert!(!state.to_string().contains("different private legacy body"));
        assert!(!state.to_string().contains("workPrompt"));
        let mut invalid =
            serde_json::to_value(creation("invalid", 1.0, None, Some("child"))).unwrap();
        invalid["workPrompt"] = json!({"unexpected":"SYNTHETIC_PRIVATE_LEGACY_BODY"});
        let mut linker = CodexSubagentLinker::new();
        linker.restore(&json!({"version":1,"spawns":[invalid]}));
        let state = linker.serialize();
        assert!(state["spawns"][0]["workFingerprint"].is_null());
        assert!(!state.to_string().contains("SYNTHETIC_PRIVATE_LEGACY_BODY"));
        assert!(!state.to_string().contains("workPrompt"));
    }
    fn reset_fact_access(linker: &CodexSubagentLinker) {
        linker.spawns.reset_access();
        linker.children.reset_access();
        linker.bindings.reset_access();
        linker.completed_results.reset_access();
        linker.work_terminals.reset_access();
    }
    fn fact_access(linker: &CodexSubagentLinker) -> (usize, usize, usize) {
        [
            linker.spawns.access_counts(),
            linker.children.access_counts(),
            linker.bindings.access_counts(),
            linker.completed_results.access_counts(),
            linker.work_terminals.access_counts(),
        ]
        .into_iter()
        .fold((0, 0, 0), |sum, n| (sum.0 + n.0, sum.1 + n.1, sum.2 + n.2))
    }
    fn indexed_owned_work() -> (CodexSubagentLinker, CodexSubagentLink) {
        let mut linker = CodexSubagentLinker::new();
        linker.register_spawns(&[spawn("mine", "work")]);
        let owned = turn("owned");
        let link = linker
            .resolve_work(&meta(), &owned, &[plain_work("owned", "work")], false)
            .unwrap();
        linker.register_completed_work_result(
            &link,
            &owned,
            &[completion("owned", Some("real result"), false)],
        );
        (linker, link)
    }
    #[test]
    fn local_work_and_parent_peer_queries_do_not_visit_unrelated_global_facts() {
        let mut observed = Vec::new();
        for unrelated in [0, 50, MAX_LINK_DESCRIPTORS / 2] {
            let (mut linker, expected) = indexed_owned_work();
            for i in 0..unrelated {
                let mut descriptor = creation(
                    &format!("other-call-{i}"),
                    1.0,
                    None,
                    Some(&format!("other-child-{i}")),
                );
                descriptor.parent_thread_id = format!("other-parent-{i}");
                linker.register_spawns(&[descriptor]);
                linker.bindings.insert(
                    format!("binding-{i}"),
                    WorkBinding {
                        child_thread_id: format!("other-child-{i}"),
                        child_turn_id: format!("other-turn-{i}"),
                        invocation_id: format!("other-invocation-{i}"),
                    },
                );
                linker.completed_results.insert(
                    format!("result-{i}"),
                    CompletedResult {
                        child_thread_id: format!("other-child-{i}"),
                        child_turn_id: format!("other-turn-{i}"),
                        invocation_id: format!("other-invocation-{i}"),
                        fingerprint: digest("other result", 64),
                    },
                );
                linker.work_terminals.insert(
                    format!("terminal-{i}"),
                    WorkTerminal {
                        child_thread_id: format!("other-child-{i}"),
                        child_turn_id: format!("other-turn-{i}"),
                        invocation_id: format!("other-invocation-{i}"),
                        terminal_type: "completed".into(),
                    },
                );
                linker.register_child(&child_meta(
                    &format!("other-child-{i}"),
                    30.0,
                    Some(&format!("/root/other-{i}")),
                ));
            }
            reset_fact_access(&linker);
            assert_eq!(
                linker.resolve_work(&meta(), &turn("owned"), &[], false),
                Some(expected)
            );
            let projection = linker.get_delegations_for_parent("parent");
            assert_eq!(projection.len(), 1);
            assert_eq!(projection[0].parent_tool_call_id, "mine");
            assert_eq!(
                projection[0].result_fingerprints,
                [digest("real result", 64)]
            );
            let counts = fact_access(&linker);
            assert_eq!(
                counts.0, 0,
                "local query created a global iterator with {unrelated} unrelated facts"
            );
            assert_eq!(counts.1, 0, "local query visited global facts");
            assert!(counts.2 > 0, "observer missed all scoped work");
            observed.push(counts.2);
        }
        assert!(
            observed.iter().all(|n| *n == observed[0]),
            "local visits scaled with unrelated facts: {observed:?}"
        );
    }
    #[test]
    fn same_scope_competition_is_visited_and_preserves_strict_ambiguity() {
        let mut linker = CodexSubagentLinker::new();
        linker.register_spawns(&[spawn("first", "same")]);
        reset_fact_access(&linker);
        assert!(linker
            .resolve_work(
                &meta(),
                &turn("first"),
                &[plain_work("first", "same")],
                false
            )
            .is_some());
        let first = fact_access(&linker);
        linker.register_spawns(&[spawn("second", "same")]);
        reset_fact_access(&linker);
        assert!(linker
            .resolve_work(
                &meta(),
                &turn("new-work"),
                &[plain_work("new-work", "same")],
                false
            )
            .is_none());
        let second = fact_access(&linker);
        assert_eq!((first.0, second.0), (0, 0));
        assert_eq!((first.1, second.1), (0, 0));
        assert!(
            second.2 > first.2,
            "local observer or index failed to observe real competition"
        );
    }
    #[test]
    fn scope_indexes_follow_resolved_binding_native_replacement_restore_and_eviction() {
        let mut linker = CodexSubagentLinker::new();
        let mut descriptor = creation("path", 1.0, Some("worker"), None);
        descriptor.work_fingerprint = Some(work_fingerprint("work"));
        linker.register_spawns(std::slice::from_ref(&descriptor));
        assert_eq!(
            linker
                .spawns
                .scoped_values(&[FactScope::ParentPath(
                    "parent".into(),
                    "/root/worker".into()
                )])
                .len(),
            1
        );
        let link = linker
            .resolve_work(
                &meta(),
                &turn("owned"),
                &[plain_work("owned", "work")],
                false,
            )
            .unwrap();
        assert_eq!(link.confidence, CodexSubagentLinkConfidence::AgentPath);
        assert!(linker
            .spawns
            .scoped_values(&[FactScope::ParentPath(
                "parent".into(),
                "/root/worker".into()
            )])
            .is_empty());
        assert_eq!(
            linker
                .spawns
                .scoped_values(&[FactScope::Child("child".into())])
                .len(),
            1
        );
        descriptor.child_thread_id = Some("native-other-child".into());
        linker.register_spawns(&[descriptor]);
        assert!(linker
            .spawns
            .scoped_values(&[FactScope::Child("child".into())])
            .is_empty());
        assert_eq!(
            linker
                .spawns
                .scoped_values(&[FactScope::Child("native-other-child".into())])
                .len(),
            1
        );
        let mut restored = CodexSubagentLinker::new();
        restored.restore(&linker.serialize());
        assert!(restored
            .spawns
            .scoped_values(&[FactScope::Child("child".into())])
            .is_empty());
        assert_eq!(
            restored
                .spawns
                .scoped_values(&[FactScope::Child("native-other-child".into())])
                .len(),
            1
        );
        assert_eq!(
            restored
                .bindings
                .scoped_values(&[FactScope::Child("child".into())])
                .len(),
            1
        );
        trim_oldest(&mut restored.spawns, 0);
        trim_oldest(&mut restored.bindings, 0);
        trim_oldest(&mut restored.children, 0);
        assert_eq!(restored.spawns.indexed_key_count(), 0);
        assert_eq!(restored.bindings.indexed_key_count(), 0);
        assert_eq!(restored.children.indexed_key_count(), 0);
        reset_fact_access(&restored);
        assert!(restored.get_delegations_for_parent("parent").is_empty());
        assert!(restored
            .resolve_work(
                &meta(),
                &turn("owned"),
                &[plain_work("owned", "work")],
                false
            )
            .is_none());
        assert_eq!(fact_access(&restored).0, 0);
    }
    #[test]
    fn unchanged_facts_and_identical_restore_reuse_actual_snapshot_and_document_builds() {
        let mut linker = CodexSubagentLinker::new();
        let mut descriptor = creation("mine", 1.0, None, Some("child"));
        descriptor.work_fingerprint = Some(work_fingerprint("work"));
        linker.register_spawns(std::slice::from_ref(&descriptor));
        let child = meta();
        let link = linker
            .resolve_work(
                &child,
                &turn("owned"),
                &[plain_work("owned", "work")],
                false,
            )
            .unwrap();
        let snapshot = linker.snapshot();
        let state = linker.serialize();
        assert_eq!(linker.snapshot_cache.build_count(), 1);
        assert_eq!(linker.serialized_cache.build_count(), 1);
        reset_fact_access(&linker);
        for _ in 0..5 {
            linker.register_spawns(std::slice::from_ref(&descriptor));
            linker.register_child(&child);
            linker.restore(&state);
            assert_eq!(linker.snapshot(), snapshot);
            assert_eq!(linker.serialize(), state);
        }
        assert_eq!(
            linker.snapshot_cache.build_count(),
            1,
            "duplicate facts rebuilt topology"
        );
        assert_eq!(
            linker.serialized_cache.build_count(),
            1,
            "duplicate facts rebuilt persisted document"
        );
        assert_eq!(
            fact_access(&linker).0,
            0,
            "cache hit rescanned canonical facts"
        );

        linker.register_completed_work_result(
            &link,
            &turn("owned"),
            &[completion("owned", Some("private result"), false)],
        );
        assert_eq!(linker.snapshot(), snapshot);
        let completed = linker.serialize();
        assert_ne!(completed, state);
        assert!(!completed.to_string().contains("private result"));
        assert_eq!(
            linker.snapshot_cache.build_count(),
            1,
            "result-only facts rebuilt unchanged topology"
        );
        assert_eq!(linker.serialized_cache.build_count(), 2);
        reset_fact_access(&linker);
        linker.register_completed_work_result(
            &link,
            &turn("owned"),
            &[completion("owned", Some("private result"), false)],
        );
        assert_eq!(linker.serialize(), completed);
        assert_eq!(linker.snapshot(), snapshot);
        assert_eq!(linker.snapshot_cache.build_count(), 1);
        assert_eq!(linker.serialized_cache.build_count(), 2);
        assert_eq!(fact_access(&linker).0, 0);

        descriptor.child_turn_id = Some("new-evidence".into());
        linker.register_spawns(&[descriptor]);
        let _ = linker.snapshot();
        let changed = linker.serialize();
        assert_ne!(changed, completed);
        assert_eq!(linker.snapshot_cache.build_count(), 2);
        assert_eq!(linker.serialized_cache.build_count(), 3);
        let mut caller_snapshot = linker.snapshot();
        caller_snapshot.links.clear();
        let mut caller_state = linker.serialize();
        caller_state["spawns"] = json!([]);
        assert_eq!(linker.snapshot().links.len(), 1);
        assert_eq!(linker.serialize()["spawns"].as_array().unwrap().len(), 1);
        assert_eq!(linker.snapshot_cache.build_count(), 2);
        assert_eq!(linker.serialized_cache.build_count(), 3);
    }
    #[test]
    fn result_and_terminal_eviction_invalidates_document_without_stale_lookup_or_topology_rebuild()
    {
        let (mut linker, _) = indexed_owned_work();
        let snapshot = linker.snapshot();
        let state = linker.serialize();
        trim_oldest(&mut linker.completed_results, 0);
        trim_oldest(&mut linker.work_terminals, 0);
        assert_eq!(linker.completed_results.indexed_key_count(), 0);
        assert_eq!(linker.work_terminals.indexed_key_count(), 0);
        assert_eq!(linker.snapshot(), snapshot);
        assert_eq!(linker.snapshot_cache.build_count(), 1);
        let after = linker.serialize();
        assert_ne!(after, state);
        assert_eq!(linker.serialized_cache.build_count(), 2);
        reset_fact_access(&linker);
        let projection = linker.get_delegations_for_parent("parent").pop().unwrap();
        assert!(projection.result_fingerprints.is_empty());
        assert!(!projection.result_terminal_observed && !projection.result_outcome_known);
        assert_eq!(fact_access(&linker).0, 0);
    }
    #[test]
    fn child_metadata_changes_refresh_scopes_and_caches_without_stale_nickname() {
        let (mut linker, _) = indexed_owned_work();
        let snapshot = linker.snapshot();
        let state = linker.serialize();
        let mut child = meta();
        child.agent_path = Some("/root/moved".into());
        child.agent_nickname = Some("NewNickname".into());
        linker.register_child(&child);
        assert!(linker
            .children
            .scoped_values(&[FactScope::ParentPath(
                "parent".into(),
                "/root/worker".into()
            )])
            .is_empty());
        assert_eq!(
            linker
                .children
                .scoped_values(&[FactScope::ParentPath("parent".into(), "/root/moved".into())])
                .len(),
            1
        );
        let changed = linker.snapshot();
        assert_ne!(changed, snapshot);
        assert_ne!(linker.serialize(), state);
        assert_eq!(linker.snapshot_cache.build_count(), 2);
        assert_eq!(linker.serialized_cache.build_count(), 2);
        let projection = linker.get_delegations_for_parent("parent").pop().unwrap();
        assert_eq!(projection.agent_nickname.as_deref(), Some("NewNickname"));
        assert_eq!(projection.agent_path.as_deref(), Some("/root/moved"));
    }
}
