//! Standard operation audit events and observed delegation receipts.
use std::collections::BTreeSet;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::subagent_linker::{CodexSpawnDescriptor, CodexSubagentLink, MAX_LINK_DESCRIPTORS};
use super::types::{
    CodexExtractedTranscriptTurn, CodexTranscriptMeta, CodexTranscriptSourceRecord,
    CodexTranscriptStep, CodexTranscriptTool,
};
use super::utils::timestamp_ms;
use crate::normalization::{entry_from_map, entry_to_object};
use crate::types::{AgentActivityEntry, AgentEventName};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PendingAgentResult {
    pub file_path: String,
    pub inode: u64,
    pub start_offset: i64,
    pub end_offset: i64,
    pub context: AgentActivityEntry,
}

fn hash(text: &str, size: usize) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))[..size].to_owned()
}
pub(super) fn turn_trace_id(turn: &CodexExtractedTranscriptTurn) -> String {
    hash(
        &[&turn.session_id, &turn.transcript_turn_id, "trace"].join("\0"),
        32,
    )
}
pub(super) fn audit_context(
    turn: &CodexExtractedTranscriptTurn,
    trace: &str,
) -> AgentActivityEntry {
    serde_json::from_value(json!({
        "time_unix_nano": ((turn.terminal_at_ms as i128) * 1_000_000).to_string(),
        "event.id": format!("{}:{}:boundary", turn.session_id, turn.transcript_turn_id),
        "event.name": "other", "user.id": "", "trace_id": trace,
        "gen_ai.session.id": turn.session_id, "gen_ai.turn.id": format!("{}:{}", turn.session_id, turn.transcript_turn_id),
        "gen_ai.agent.type": "codex", "gen_ai.agent.id": turn.session_id,
        "gen_ai.provider.name": turn.provider, "agent.codex.transcript_turn_id": turn.transcript_turn_id
    })).expect("Codex audit context")
}
pub(super) fn stamp_delegation(
    entries: &mut [AgentActivityEntry],
    link: &CodexSubagentLink,
    meta: Option<&CodexTranscriptMeta>,
    attach: bool,
) {
    for entry in entries {
        if let Some(id) = &link.invocation_id {
            entry
                .extra
                .insert("gen_ai.agent.parent.invocation.id".into(), json!(id));
        }
        entry.extra.insert(
            "gen_ai.agent.parent.id".into(),
            json!(link.parent_thread_id),
        );
        if let Some(name) = meta.and_then(|meta| meta.agent_nickname.as_ref()) {
            entry.agent_name = Some(name.clone());
        }
        if let Some(call) = &link.parent_tool_call_id {
            entry
                .extra
                .insert("gen_ai.subagent.parent_tool_call.id".into(), json!(call));
        }
        if let Some(parent) = link.parent_tool_span_id.as_ref().filter(|_| attach) {
            entry
                .extra
                .insert("gen_ai.agent.scope".into(), json!("subagent"));
            entry.extra.insert(
                "gen_ai.agent.depth".into(),
                json!(meta.map_or(1, |meta| meta.depth)),
            );
            entry
                .extra
                .insert("agent.codex.delegated".into(), json!(true));
            entry
                .extra
                .insert("agent.codex.parent_span_id".into(), json!(parent));
        }
    }
}
fn parsed(value: Option<&Value>) -> Value {
    match value {
        Some(Value::String(text)) => serde_json::from_str(text).unwrap_or_else(|_| json!(text)),
        Some(value) => value.clone(),
        None => Value::Null,
    }
}
fn text_message(value: Option<&Value>) -> Option<Value> {
    let value = value?;
    let parts = match value {
        Value::String(text) if !text.is_empty() => vec![json!({"type": "text", "content": text})],
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| {
                part.get("text")
                    .and_then(Value::as_str)
                    .map(|text| json!({"type":"text","content":text}))
            })
            .collect(),
        _ => return None,
    };
    (!parts.is_empty()).then(|| json!({"role": "user", "parts": parts}))
}
pub(super) fn append_invocations(
    entries: Vec<AgentActivityEntry>,
    spawns: &[CodexSpawnDescriptor],
) -> Vec<AgentActivityEntry> {
    let mut output = Vec::new();
    for original in entries {
        let works: Vec<_> = spawns
            .iter()
            .filter(|work| original.tool_call_id.as_deref() == Some(&work.parent_tool_call_id))
            .collect();
        let mut fields = entry_to_object(&original);
        if works.len() == 1 {
            if let Some(invocation) = &works[0].invocation_id {
                fields.insert("gen_ai.agent.invocation.id".into(), json!(invocation));
            }
        }
        output.push(entry_from_map(fields.clone()));
        if original.event_name != Some(AgentEventName::ToolCall) {
            continue;
        }
        let args = parsed(fields.get("gen_ai.tool.call.arguments"));
        let tasks = args
            .get("agents")
            .or_else(|| args.get("tasks"))
            .and_then(Value::as_array);
        for work in works {
            let Some(invocation) = &work.invocation_id else {
                continue;
            };
            let task = tasks
                .map(|tasks| tasks.get(work.work_index))
                .unwrap_or(Some(&args));
            let message = task.and_then(|task| {
                ["message", "prompt", "input"]
                    .iter()
                    .find_map(|key| text_message(task.get(*key)))
            });
            let mut invoke = fields.clone();
            invoke.insert("event.name".into(), json!("gen_ai.agent.invoke"));
            invoke.insert(
                "event.id".into(),
                json!(hash(&format!("{invocation}\0invoke"), 32)),
            );
            invoke.insert("gen_ai.agent.invocation.id".into(), json!(invocation));
            if let Some(child) = &work.child_thread_id {
                invoke.insert("gen_ai.agent.peer.id".into(), json!(child));
            }
            if let Some(name) = &work.agent_nickname {
                invoke.insert("gen_ai.agent.peer.name".into(), json!(name));
            }
            invoke.remove("gen_ai.input.messages");
            invoke.remove("gen_ai.input.messages_delta");
            if let Some(message) = message {
                invoke.insert("gen_ai.input.messages".into(), json!([message]));
            }
            for key in [
                "gen_ai.tool.call.arguments",
                "gen_ai.tool.call.result",
                "tool.result.status",
            ] {
                invoke.remove(key);
            }
            output.push(entry_from_map(invoke));
        }
    }
    output
}
pub(super) fn with_pending_dispatches(
    turn: &CodexExtractedTranscriptTurn,
    records: &[CodexTranscriptSourceRecord],
) -> CodexExtractedTranscriptTurn {
    let known: BTreeSet<_> = turn
        .steps
        .iter()
        .flat_map(|step| step.tools.iter().map(|tool| tool.call_id.as_str()))
        .collect();
    let mut pending: IndexMap<String, CodexTranscriptTool> = IndexMap::new();
    for source in records {
        if source.record.get("type").and_then(Value::as_str) != Some("response_item") {
            continue;
        }
        let Some(payload) = source.record.get("payload") else {
            continue;
        };
        let Some(call) = payload
            .get("call_id")
            .and_then(Value::as_str)
            .filter(|call| !known.contains(call))
        else {
            continue;
        };
        if payload["type"] == "function_call" {
            let Some(name) = payload.get("name").and_then(Value::as_str) else {
                continue;
            };
            if !matches!(
                name.rsplit(['.', '/']).next(),
                Some("spawn_agent" | "followup_task" | "send_input")
            ) {
                continue;
            }
            pending.insert(
                call.into(),
                CodexTranscriptTool {
                    call_id: call.into(),
                    name: name.into(),
                    input: Some(parsed(payload.get("arguments"))),
                    started_at_ms: timestamp_ms(&source.record, turn.started_at_ms),
                    output: None,
                    completed_at_ms: None,
                },
            );
        } else if payload["type"] == "function_call_output" {
            if let Some(tool) = pending.get_mut(call) {
                tool.output = Some(parsed(payload.get("output")));
                tool.completed_at_ms = Some(timestamp_ms(&source.record, turn.terminal_at_ms));
            }
        }
    }
    let mut output = turn.clone();
    if !pending.is_empty() {
        output.steps.push(CodexTranscriptStep {
            started_at_ms: pending
                .values()
                .map(|tool| tool.started_at_ms)
                .fold(f64::INFINITY, f64::min),
            response_at_ms: turn.terminal_at_ms,
            has_response_evidence: false,
            completed_at_ms: turn.terminal_at_ms,
            response_id: None,
            input_messages: None,
            reasoning: Vec::new(),
            tools: pending.into_values().collect(),
            token_usage: None,
            final_text: None,
        });
    }
    output
}
pub(super) struct ResultContext<'a> {
    pub receiving_session: &'a str,
    pub delivered: &'a mut BTreeSet<String>,
    pub fallback: &'a AgentActivityEntry,
    pub pending: &'a mut IndexMap<String, PendingAgentResult>,
    pub file_path: &'a str,
    pub inode: u64,
}
struct Receipt {
    source: AgentActivityEntry,
    key: String,
    peer: Option<String>,
    value: Value,
    call_id: Option<String>,
    child_turn: Option<String>,
    invocation: Option<String>,
    terminal: bool,
}
#[derive(PartialEq)]
enum ReceiptOutcome {
    Emitted,
    Duplicate,
    Unresolved,
}
fn string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}
fn result_fingerprint(value: &Value) -> String {
    let text = value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| value.to_string());
    let body = if text.contains("Message Type: FINAL_ANSWER") {
        text.find("\nPayload:")
            .map(|position| {
                let body = &text[position + "\nPayload:".len()..];
                body.trim_start_matches([' ', '\t'])
                    .strip_prefix("\r\n")
                    .or_else(|| body.trim_start_matches([' ', '\t']).strip_prefix('\n'))
                    .unwrap_or(body)
            })
            .unwrap_or(&text)
    } else {
        &text
    };
    hash(body, 64)
}
fn append_receipt(
    output: &mut Vec<AgentActivityEntry>,
    receipt: Receipt,
    descriptors: &[CodexSpawnDescriptor],
    context: &mut ResultContext<'_>,
) -> ReceiptOutcome {
    let peers: BTreeSet<_> = descriptors
        .iter()
        .filter(|work| {
            receipt.peer.as_ref().is_some_and(|peer| {
                work.agent_path.as_ref() == Some(peer) || work.task_name.as_ref() == Some(peer)
            })
        })
        .filter_map(|work| work.child_thread_id.as_ref())
        .collect();
    let observed = receipt
        .source
        .time_unix_nano
        .parse::<i128>()
        .unwrap_or_default();
    let candidates: Vec<_> = descriptors
        .iter()
        .filter(|work| {
            work.parent_thread_id == context.receiving_session
                && receipt
                    .invocation
                    .as_ref()
                    .is_none_or(|id| work.invocation_id.as_ref() == Some(id))
                && (work.spawned_at_ms as i128) * 1_000_000 <= observed
                && receipt
                    .call_id
                    .as_ref()
                    .is_none_or(|id| &work.parent_tool_call_id == id)
                && receipt.peer.as_ref().is_none_or(|peer| {
                    work.child_thread_id.as_ref() == Some(peer)
                        || work.agent_path.as_ref() == Some(peer)
                        || work.task_name.as_ref() == Some(peer)
                        || work
                            .child_thread_id
                            .as_ref()
                            .is_some_and(|id| peers.contains(id))
                })
                && receipt.child_turn.as_ref().is_none_or(|id| {
                    work.child_turn_id.as_ref() == Some(id)
                        || work.result_child_turn_ids.contains(id)
                })
        })
        .collect();
    let fingerprint = result_fingerprint(&receipt.value);
    let proven: Vec<_> = candidates
        .iter()
        .filter(|work| work.result_fingerprints.contains(&fingerprint))
        .copied()
        .collect();
    let all_known = candidates.iter().all(|work| work.result_outcome_known);
    if candidates.len() > 1
        && all_known
        && !proven.is_empty()
        && proven.iter().all(|work| {
            work.invocation_id
                .as_ref()
                .is_some_and(|id| context.delivered.contains(id))
        })
    {
        return ReceiptOutcome::Duplicate;
    }
    let work = if candidates.len() == 1 {
        candidates.first().copied()
    } else if proven.len() == 1 && all_known {
        proven.first().copied()
    } else {
        None
    };
    let Some(work) = work.filter(|_| proven.len() <= 1) else {
        return ReceiptOutcome::Unresolved;
    };
    let Some(invocation) = &work.invocation_id else {
        return ReceiptOutcome::Unresolved;
    };
    if context.delivered.contains(invocation) {
        return ReceiptOutcome::Duplicate;
    }
    let mut fields = entry_to_object(&receipt.source);
    fields.insert("event.name".into(), json!("gen_ai.agent.result"));
    fields.insert(
        "event.id".into(),
        json!(hash(
            &[context.receiving_session, &receipt.key, invocation].join("\0"),
            32
        )),
    );
    fields.insert("gen_ai.agent.invocation.id".into(), json!(invocation));
    if let Some(id) = &work.child_thread_id {
        fields.insert("gen_ai.agent.peer.id".into(), json!(id));
    }
    if let Some(name) = &work.agent_nickname {
        fields.insert("gen_ai.agent.peer.name".into(), json!(name));
    }
    fields.insert("gen_ai.output.messages".into(), json!([{"role":"assistant","parts":[{"type":"text",
        "content": receipt.value.as_str().map(str::to_owned).unwrap_or_else(|| receipt.value.to_string())}]}]));
    fields.retain(|key, _| {
        !key.starts_with("gen_ai.usage.")
            && !matches!(
                key.as_str(),
                "gen_ai.input.messages"
                    | "gen_ai.input.messages_delta"
                    | "gen_ai.tool.call.arguments"
                    | "gen_ai.tool.call.result"
                    | "tool.result.status"
            )
    });
    output.push(entry_from_map(fields));
    if receipt.terminal {
        context.delivered.insert(invocation.clone());
    }
    while context.delivered.len() > MAX_LINK_DESCRIPTORS {
        context.delivered.pop_first();
    }
    ReceiptOutcome::Emitted
}
fn identity_context(source: &AgentActivityEntry) -> AgentActivityEntry {
    let fields = entry_to_object(source)
        .into_iter()
        .filter(|(key, _)| {
            matches!(
                key.as_str(),
                "time_unix_nano"
                    | "observed_time_unix_nano"
                    | "event.id"
                    | "event.name"
                    | "user.id"
                    | "trace_id"
                    | "gen_ai.session.id"
                    | "gen_ai.turn.id"
                    | "gen_ai.agent.id"
                    | "gen_ai.agent.type"
                    | "gen_ai.agent.name"
                    | "gen_ai.agent.parent.id"
                    | "gen_ai.agent.parent.invocation.id"
                    | "gen_ai.agent.scope"
                    | "gen_ai.agent.depth"
                    | "gen_ai.provider.name"
                    | "gen_ai.subagent.parent_tool_call.id"
                    | "resourceAttributes"
                    | "agent.codex.cwd"
                    | "agent.codex.transcript_turn_id"
                    | "agent.codex.delegated"
                    | "agent.codex.parent_span_id"
            )
        })
        .collect();
    entry_from_map(fields)
}
pub(super) fn append_agent_results(
    entries: Vec<AgentActivityEntry>,
    records: &[CodexTranscriptSourceRecord],
    descriptors: &[CodexSpawnDescriptor],
    mut context: ResultContext<'_>,
) -> Vec<AgentActivityEntry> {
    let base = entries
        .iter()
        .find(|entry| entry.event_name == Some(AgentEventName::LlmRequest))
        .or_else(|| entries.first())
        .unwrap_or(context.fallback)
        .clone();
    let mut output = entries.clone();
    for entry in &entries {
        if entry.event_name != Some(AgentEventName::ToolResult) {
            continue;
        }
        let fields = entry_to_object(entry);
        let result = parsed(fields.get("gen_ai.tool.call.result"));
        let dispatch: Vec<_> = descriptors
            .iter()
            .filter(|work| entry.tool_call_id.as_deref() == Some(&work.parent_tool_call_id))
            .collect();
        let failed = result
            .get("error")
            .is_some_and(|value| !value.is_null() && value != &json!(false))
            || result.get("success") == Some(&json!(false))
            || matches!(
                result.get("status").and_then(Value::as_str),
                Some("failed" | "rejected")
            );
        for work in dispatch {
            if work.dispatch_failed || failed {
                let mut receipt_source = entry.clone();
                receipt_source.error_type = Some("codex.delegation_failed".into());
                append_receipt(
                    &mut output,
                    Receipt {
                        source: receipt_source,
                        key: format!("{}:dispatch-failed:{}", entry.event_id, work.work_index),
                        peer: work.child_thread_id.clone(),
                        value: result.clone(),
                        call_id: entry.tool_call_id.clone(),
                        child_turn: None,
                        invocation: work.invocation_id.clone(),
                        terminal: true,
                    },
                    descriptors,
                    &mut context,
                );
            }
        }
        if !entry.tool_name.as_deref().is_some_and(|name| {
            matches!(
                name.rsplit(['.', '/']).next(),
                Some("wait" | "wait_agent" | "wait_threads")
            )
        }) {
            continue;
        }
        if let Some(status) = result.get("status").and_then(Value::as_object) {
            for (peer, state) in status {
                if let Some(value) = ["completed", "errored", "failed"]
                    .iter()
                    .find_map(|key| state.get(*key))
                    .filter(|value| !value.is_null())
                {
                    append_receipt(
                        &mut output,
                        Receipt {
                            source: entry.clone(),
                            key: format!("{}:{peer}", entry.event_id),
                            peer: Some(peer.clone()),
                            value: value.clone(),
                            call_id: None,
                            child_turn: None,
                            invocation: None,
                            terminal: true,
                        },
                        descriptors,
                        &mut context,
                    );
                }
            }
        }
        if let Some(results) = result.get("results").and_then(Value::as_array) {
            for receipt in results {
                if !matches!(
                    receipt["status"].as_str(),
                    Some("completed" | "failed" | "errored")
                ) {
                    continue;
                }
                if let Some(value) = ["output", "result", "error"]
                    .iter()
                    .find_map(|key| receipt.get(*key))
                    .filter(|value| !value.is_null())
                {
                    append_receipt(
                        &mut output,
                        Receipt {
                            source: entry.clone(),
                            key: format!(
                                "{}:{}",
                                entry.event_id,
                                string(receipt, "agent_id").unwrap_or_default()
                            ),
                            peer: string(receipt, "agent_id"),
                            value: value.clone(),
                            call_id: None,
                            child_turn: string(receipt, "turn_id"),
                            invocation: None,
                            terminal: true,
                        },
                        descriptors,
                        &mut context,
                    );
                }
            }
        }
    }
    for source in records {
        let Some(payload) = source.record.get("payload") else {
            continue;
        };
        let mut receipt_source = base.clone();
        receipt_source.span_id = None;
        receipt_source.parent_span_id = None;
        receipt_source.step_id = None;
        receipt_source.response_id = None;
        receipt_source.time_unix_nano =
            ((timestamp_ms(&source.record, 0.0) as i128) * 1_000_000).to_string();
        if source.record.get("type").and_then(Value::as_str) == Some("response_item")
            && payload["type"] == "agent_message"
        {
            let text = payload
                .get("content")
                .and_then(Value::as_array)
                .map(|parts| {
                    parts
                        .iter()
                        .filter_map(|part| part.get("text").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default();
            if !text
                .split_whitespace()
                .collect::<Vec<_>>()
                .windows(3)
                .any(|words| words == ["Message", "Type:", "FINAL_ANSWER"])
            {
                continue;
            }
            let metadata = &payload["internal_chat_message_metadata_passthrough"];
            let outcome = append_receipt(
                &mut output,
                Receipt {
                    source: receipt_source.clone(),
                    key: format!("message:{}", source.start_offset),
                    peer: string(payload, "author").or_else(|| string(payload, "agent_id")),
                    value: json!(text),
                    call_id: string(metadata, "tool_call_id"),
                    child_turn: string(metadata, "source_turn_id"),
                    invocation: string(metadata, "invocation_id"),
                    terminal: true,
                },
                descriptors,
                &mut context,
            );
            if outcome == ReceiptOutcome::Unresolved {
                context
                    .pending
                    .entry(format!("{}:{}", context.file_path, source.start_offset))
                    .or_insert_with(|| PendingAgentResult {
                        file_path: context.file_path.into(),
                        inode: context.inode,
                        start_offset: source.start_offset,
                        end_offset: source.end_offset,
                        context: identity_context(&receipt_source),
                    });
                while context.pending.len() > MAX_LINK_DESCRIPTORS {
                    context.pending.shift_remove_index(0);
                }
            }
        } else if source.record.get("type").and_then(Value::as_str) == Some("event_msg")
            && payload["type"] == "sub_agent_activity"
            && matches!(
                payload["kind"].as_str(),
                Some("completed" | "result" | "failed")
            )
        {
            if let Some(value) = ["result", "output", "message", "error"]
                .iter()
                .find_map(|key| payload.get(*key))
            {
                append_receipt(
                    &mut output,
                    Receipt {
                        source: receipt_source,
                        key: format!("activity:{}", source.start_offset),
                        peer: string(payload, "agent_thread_id")
                            .or_else(|| string(payload, "agent_id")),
                        value: value.clone(),
                        call_id: string(payload, "event_id").or_else(|| string(payload, "call_id")),
                        child_turn: string(payload, "agent_turn_id"),
                        invocation: string(payload, "invocation_id"),
                        terminal: payload["kind"] != "result",
                    },
                    descriptors,
                    &mut context,
                );
            }
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str) -> AgentActivityEntry {
        serde_json::from_value(json!({"event.name":name,"event.id":"original",
            "time_unix_nano":"100000000","gen_ai.agent.type":"codex","user.id":"user",
            "gen_ai.session.id":"parent","gen_ai.turn.id":"parent:turn","gen_ai.tool.call.id":"call",
            "gen_ai.tool.call.arguments":{"tasks":[{"message":"first"},null,{"message":"third"}]},
            "gen_ai.input.messages":[{"role":"user","parts":[{"type":"text","content":"unrelated original prompt"}]}]
        })).unwrap()
    }
    fn work(index: usize) -> CodexSpawnDescriptor {
        CodexSpawnDescriptor {
            parent_thread_id: "parent".into(),
            parent_turn_id: "turn".into(),
            parent_tool_call_id: "call".into(),
            invocation_id: Some(format!("invocation-{index}")),
            child_thread_id: Some("child".into()),
            work_index: index,
            spawned_at_ms: 1.0,
            ..Default::default()
        }
    }

    #[test]
    fn batch_invocations_keep_positions_and_never_copy_a_siblings_prompt() {
        let output = append_invocations(vec![entry("tool.call")], &[work(0), work(1), work(2)]);
        let invocations: Vec<_> = output
            .iter()
            .filter(|entry| entry.event_name == Some(AgentEventName::AgentInvoke))
            .collect();
        assert_eq!(invocations.len(), 3);
        assert!(serde_json::to_string(&invocations[0].input_messages)
            .unwrap()
            .contains("first"));
        assert!(invocations[1].input_messages.is_none());
        assert!(serde_json::to_string(&invocations[2].input_messages)
            .unwrap()
            .contains("third"));
        assert!(invocations
            .iter()
            .all(|entry| entry.tool_call_arguments.is_none()));
        assert!(!serde_json::to_string(&invocations)
            .unwrap()
            .contains("unrelated original prompt"));
        assert_eq!(
            output
                .iter()
                .filter(|entry| entry.event_name == Some(AgentEventName::ToolCall))
                .count(),
            1
        );
    }

    #[test]
    fn model_and_tool_facts_are_emitted_once_without_synthetic_aliases() {
        let names = [
            "llm.request",
            "llm.response",
            "tool.call",
            "tool.result",
            "gen_ai.model.request",
            "gen_ai.model.response",
            "gen_ai.tool.call",
            "gen_ai.tool.result",
        ];
        for name in names {
            let original = entry(name);
            let output = append_invocations(vec![original.clone()], &[]);
            assert_eq!(output.len(), 1);
            assert_eq!(output[0].event_name, original.event_name);
            assert_eq!(output[0].event_id, original.event_id);
        }
    }

    #[test]
    fn result_matching_waits_until_every_candidate_outcome_is_known_and_deduplicates_delivery() {
        let fallback = entry("other");
        let mut delivered = BTreeSet::new();
        let mut pending = IndexMap::new();
        let mut context = ResultContext {
            receiving_session: "parent",
            delivered: &mut delivered,
            fallback: &fallback,
            pending: &mut pending,
            file_path: "/native.jsonl",
            inode: 1,
        };
        let receipt = || Receipt {
            source: fallback.clone(),
            key: "receipt".into(),
            peer: Some("child".into()),
            value: json!("result"),
            call_id: None,
            child_turn: None,
            invocation: None,
            terminal: true,
        };
        let mut first = work(0);
        first.result_fingerprints = vec![hash("result", 64)];
        first.result_outcome_known = true;
        let mut second = work(1);
        let mut output = Vec::new();
        assert!(
            append_receipt(
                &mut output,
                receipt(),
                &[first.clone(), second.clone()],
                &mut context
            ) == ReceiptOutcome::Unresolved
        );
        assert!(output.is_empty());
        second.result_outcome_known = true;
        second.result_fingerprints = vec![hash("different", 64)];
        assert!(
            append_receipt(
                &mut output,
                receipt(),
                &[first.clone(), second.clone()],
                &mut context
            ) == ReceiptOutcome::Emitted
        );
        assert_eq!(
            output[0].get("gen_ai.agent.invocation.id"),
            Some(&json!("invocation-0"))
        );
        assert!(
            append_receipt(&mut output, receipt(), &[first, second], &mut context)
                == ReceiptOutcome::Duplicate
        );
        assert_eq!(output.len(), 1);
    }

    #[test]
    fn unresolved_native_result_retains_only_source_range_and_identity_for_replay() {
        let fallback = entry("other");
        let record = CodexTranscriptSourceRecord {
            start_offset: 100,
            end_offset: 500,
            record: json!({"type":"response_item","timestamp":"2026-10-29T00:00:00Z",
                "payload":{"type":"agent_message","author":"child","content":[{"text":
                    "Message Type: FINAL_ANSWER\nPayload:\nprivate completion body"}]}})
            .as_object()
            .unwrap()
            .clone(),
        };
        let mut delivered = BTreeSet::new();
        let mut pending = IndexMap::new();
        let output = append_agent_results(
            Vec::new(),
            &[record],
            &[],
            ResultContext {
                receiving_session: "parent",
                delivered: &mut delivered,
                fallback: &fallback,
                pending: &mut pending,
                file_path: "/native.jsonl",
                inode: 42,
            },
        );
        assert!(output.is_empty());
        assert_eq!(pending.len(), 1);
        let serialized = serde_json::to_value(pending.values().next().unwrap()).unwrap();
        assert_eq!(serialized["startOffset"], 100);
        assert_eq!(serialized["endOffset"], 500);
        assert_eq!(serialized["inode"], 42);
        assert!(!serialized.to_string().contains("private completion body"));
        assert!(!serialized.to_string().contains("unrelated original prompt"));
    }
    #[test]
    fn late_result_keeps_receiving_turn_and_original_invocation_after_identity_restore() {
        let mut received = entry("other");
        received.turn_id = Some("parent:later-turn".into());
        received.event_id = "late-receipt".into();
        let mut descriptor = work(0);
        descriptor.parent_turn_id = "original-dispatch-turn".into();
        descriptor.result_fingerprints = vec![hash("real result\n", 64)];
        descriptor.result_outcome_known = true;
        let mut delivered = BTreeSet::new();
        let mut pending = IndexMap::new();
        let mut output = Vec::new();
        let mut context = ResultContext {
            receiving_session: "parent",
            delivered: &mut delivered,
            fallback: &received,
            pending: &mut pending,
            file_path: "/synthetic/native.jsonl",
            inode: 1,
        };
        let receipt = || Receipt {
            source: received.clone(),
            key: "late-native-range".into(),
            peer: Some("child".into()),
            value: json!("real result\n"),
            call_id: None,
            child_turn: None,
            invocation: None,
            terminal: true,
        };
        assert!(
            append_receipt(&mut output, receipt(), &[descriptor.clone()], &mut context)
                == ReceiptOutcome::Emitted
        );
        assert_eq!(output.len(), 1);
        assert_eq!(output[0].turn_id.as_deref(), Some("parent:later-turn"));
        assert_eq!(
            output[0].get("gen_ai.agent.invocation.id"),
            Some(&json!("invocation-0"))
        );
        assert_eq!(output[0].get("gen_ai.agent.peer.id"), Some(&json!("child")));
        assert!(output[0].input_messages.is_none() && output[0].tool_call_arguments.is_none());
        let serialized = serde_json::to_string(&delivered).unwrap();
        assert!(!serialized.contains("real result"));
        let mut restored: BTreeSet<String> = serde_json::from_str(&serialized).unwrap();
        let mut context = ResultContext {
            receiving_session: "parent",
            delivered: &mut restored,
            fallback: &received,
            pending: &mut pending,
            file_path: "/synthetic/native.jsonl",
            inode: 1,
        };
        assert!(
            append_receipt(&mut output, receipt(), &[descriptor], &mut context)
                == ReceiptOutcome::Duplicate
        );
        assert_eq!(output.len(), 1);
    }

    #[test]
    fn identical_completed_results_remain_ambiguous_and_explicit_invocation_disambiguates() {
        let fallback = entry("other");
        let mut delivered = BTreeSet::new();
        let mut pending = IndexMap::new();
        let mut output = Vec::new();
        let mut descriptors = vec![work(0), work(1)];
        for descriptor in &mut descriptors {
            descriptor.result_outcome_known = true;
            descriptor.result_fingerprints = vec![hash("same result", 64)];
        }
        let mut context = ResultContext {
            receiving_session: "parent",
            delivered: &mut delivered,
            fallback: &fallback,
            pending: &mut pending,
            file_path: "/synthetic/native.jsonl",
            inode: 1,
        };
        let receipt = |invocation| Receipt {
            source: fallback.clone(),
            key: "native-range".into(),
            peer: Some("child".into()),
            value: json!("same result"),
            call_id: None,
            child_turn: None,
            invocation,
            terminal: true,
        };
        assert!(
            append_receipt(&mut output, receipt(None), &descriptors, &mut context)
                == ReceiptOutcome::Unresolved
        );
        assert!(output.is_empty());
        assert!(
            append_receipt(
                &mut output,
                receipt(Some("invocation-1".into())),
                &descriptors,
                &mut context
            ) == ReceiptOutcome::Emitted
        );
        assert_eq!(
            output[0].get("gen_ai.agent.invocation.id"),
            Some(&json!("invocation-1"))
        );
    }

    #[test]
    fn exact_receipt_hash_keeps_trailing_newlines_distinct_across_reused_child_work() {
        let fallback = entry("other");
        let mut delivered = BTreeSet::new();
        let mut pending = IndexMap::new();
        let mut output = Vec::new();
        let mut first = work(0);
        first.result_outcome_known = true;
        first.result_fingerprints = vec![hash("result\n", 64)];
        let mut second = work(1);
        second.result_outcome_known = true;
        second.result_fingerprints = vec![hash("result", 64)];
        let mut context = ResultContext {
            receiving_session: "parent",
            delivered: &mut delivered,
            fallback: &fallback,
            pending: &mut pending,
            file_path: "/synthetic/native.jsonl",
            inode: 1,
        };
        let receipt = |value| Receipt {
            source: fallback.clone(),
            key: "native-range".into(),
            peer: Some("child".into()),
            value,
            call_id: None,
            child_turn: None,
            invocation: None,
            terminal: true,
        };
        assert!(
            append_receipt(
                &mut output,
                receipt(json!("Message Type: FINAL_ANSWER\nPayload:\nresult\n")),
                &[first.clone(), second.clone()],
                &mut context
            ) == ReceiptOutcome::Emitted
        );
        assert_eq!(
            output[0].get("gen_ai.agent.invocation.id"),
            Some(&json!("invocation-0"))
        );
        assert!(
            append_receipt(
                &mut output,
                receipt(json!("result")),
                &[first, second],
                &mut context
            ) == ReceiptOutcome::Emitted
        );
        assert_eq!(
            output[1].get("gen_ai.agent.invocation.id"),
            Some(&json!("invocation-1"))
        );
    }
}
