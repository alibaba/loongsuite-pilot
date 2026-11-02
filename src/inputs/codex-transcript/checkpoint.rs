//! Checkpoint parse/save. Field names match the TypeScript objects stored in `extra.codexTranscript`.

use serde_json::{Map, Value};

use super::types::{
    CodexActiveTranscriptTurn, CodexForkBootstrap, CodexPendingFusionChild, CodexPendingFusionTurn,
    CodexPendingSubagentTurn, CodexPendingTerminalTurn, CodexTranscriptCheckpoint,
    CodexTranscriptInputContext, CodexTranscriptSourceRange, ForkBootstrapState, FusionConfidence,
};
use super::utils::{as_record, i64_value, number_value, string_array, string_value, u64_value};

pub fn checkpoint_to_value(checkpoint: &CodexTranscriptCheckpoint) -> Value {
    serde_json::to_value(checkpoint).unwrap_or(Value::Null)
}

pub fn parse_checkpoint(raw: &Value) -> Option<CodexTranscriptCheckpoint> {
    let value = as_record(raw)?;
    let inode = u64_value(value.get("inode"))?;
    let scan_offset = i64_value(value.get("scanOffset"))?;
    let active_turn = parse_active_turn(value.get("activeTurn"));
    let pending = value.get("pendingTerminal").and_then(as_record);
    let mut pending_terminal = pending.and_then(|pending| {
        let turn_id = string_value(pending.get("turnId"))?.to_owned();
        let terminal_end_offset = i64_value(pending.get("terminalEndOffset"))?;
        Some(CodexPendingTerminalTurn {
            turn_id,
            terminal_end_offset,
            retry_count: number_value(pending.get("retryCount")).map(|value| value as u64),
            first_pending_at_ms: number_value(pending.get("firstPendingAtMs")),
            last_attempt_at_ms: number_value(pending.get("lastAttemptAtMs")),
            source_record_count: number_value(pending.get("sourceRecordCount"))
                .map(|value| value as u64),
        })
    });
    let fusion = value.get("pendingFusion").and_then(as_record);
    let fusion_children =
        parse_pending_fusion_children(fusion.and_then(|item| item.get("children")));
    let pending_fusion = fusion.and_then(|fusion| {
        if fusion_children.is_empty() {
            return None;
        }
        Some(CodexPendingFusionTurn {
            turn_id: string_value(fusion.get("turnId"))?.to_owned(),
            parent_thread_id: string_value(fusion.get("parentThreadId"))?.to_owned(),
            parent_trace_id: string_value(fusion.get("parentTraceId"))?.to_owned(),
            terminal_end_offset: i64_value(fusion.get("terminalEndOffset"))?,
            children: fusion_children,
        })
    });
    let subagent = value.get("pendingSubagent").and_then(as_record);
    let captured = subagent.and_then(|item| parse_active_turn(item.get("activeTurn")));
    let confidence = subagent
        .and_then(|item| item.get("confidence"))
        .and_then(Value::as_str)
        .and_then(FusionConfidence::parse);
    let pending_subagent = match (subagent, captured, confidence) {
        (Some(subagent), Some(active_turn), Some(confidence)) => {
            let turn_id = string_value(subagent.get("turnId")).map(str::to_owned);
            let parent_thread_id = string_value(subagent.get("parentThreadId")).map(str::to_owned);
            let parent_turn_id = string_value(subagent.get("parentTurnId")).map(str::to_owned);
            let parent_trace_id = string_value(subagent.get("parentTraceId")).map(str::to_owned);
            let parent_tool_call_id =
                string_value(subagent.get("parentToolCallId")).map(str::to_owned);
            let terminal_end_offset = i64_value(subagent.get("terminalEndOffset"));
            match (
                turn_id,
                parent_thread_id,
                parent_turn_id,
                parent_trace_id,
                parent_tool_call_id,
                terminal_end_offset,
            ) {
                (
                    Some(turn_id),
                    Some(parent_thread_id),
                    Some(parent_turn_id),
                    Some(parent_trace_id),
                    Some(parent_tool_call_id),
                    Some(terminal_end_offset),
                ) => Some(CodexPendingSubagentTurn {
                    turn_id,
                    parent_thread_id,
                    parent_turn_id,
                    parent_trace_id,
                    parent_tool_call_id,
                    confidence,
                    terminal_end_offset,
                    active_turn,
                }),
                _ => None,
            }
        }
        _ => None,
    };
    if pending_subagent.is_none() && pending_terminal.is_none() {
        if let (Some(subagent), Some(active)) = (subagent, active_turn.as_ref()) {
            if string_value(subagent.get("turnId")) == Some(active.turn_id.as_str()) {
                if let Some(end) = i64_value(subagent.get("terminalEndOffset")) {
                    pending_terminal = Some(new_pending_terminal(active.turn_id.clone(), end, 0));
                }
            }
        }
    }
    let fork_bootstrap = parse_fork_bootstrap(value.get("forkBootstrap"));
    Some(CodexTranscriptCheckpoint {
        first_owned_turn_id: string_value(value.get("firstOwnedTurnId")).map(str::to_owned),
        inode,
        scan_offset,
        active_turn,
        pending_terminal,
        pending_fusion,
        pending_subagent,
        owner_session_meta_offset: i64_value(value.get("ownerSessionMetaOffset")),
        fork_bootstrap,
    })
}

pub fn new_pending_terminal(
    turn_id: String,
    terminal_end_offset: i64,
    source_record_count: u64,
) -> CodexPendingTerminalTurn {
    let now = super::utils::now_ms();
    CodexPendingTerminalTurn {
        turn_id,
        terminal_end_offset,
        retry_count: Some(1),
        first_pending_at_ms: Some(now),
        last_attempt_at_ms: Some(now),
        source_record_count: Some(source_record_count),
    }
}

pub fn parse_active_turn(value: Option<&Value>) -> Option<CodexActiveTranscriptTurn> {
    let active = value.and_then(as_record)?;
    let turn_id = string_value(active.get("turnId"))?.to_owned();
    let start_offset = i64_value(active.get("startOffset"))?;
    let started_at_ms = number_value(active.get("startedAtMs"))?;
    Some(CodexActiveTranscriptTurn {
        turn_id,
        start_offset,
        started_at_ms,
        next_step_started_at_ms: number_value(active.get("nextStepStartedAtMs")),
        last_cumulative_token_total: number_value(active.get("lastCumulativeTokenTotal")),
        model: string_value(active.get("model")).map(str::to_owned),
        cwd: string_value(active.get("cwd")).map(str::to_owned),
        developer_instructions: string_value(active.get("developerInstructions"))
            .map(str::to_owned),
        emitted_prompt: active.get("emittedPrompt").and_then(Value::as_bool) == Some(true),
        emitted_step_count: number_value(active.get("emittedStepCount"))
            .map(|value| value as u64)
            .unwrap_or(0),
        emitted_step_request_ids: string_array(active.get("emittedStepRequestIds")),
        emitted_step_response_ids: string_array(active.get("emittedStepResponseIds")),
        emitted_tool_call_ids: string_array(active.get("emittedToolCallIds")),
        emitted_tool_result_ids: string_array(active.get("emittedToolResultIds")),
        input_context: parse_input_context(active.get("inputContext")),
        subagent_spawns: parse_pending_fusion_children(active.get("subagentSpawns")),
        delegation: active
            .get("delegation")
            .and_then(|value| serde_json::from_value(value.clone()).ok()),
        delegation_unbound: active.get("delegationUnbound").and_then(Value::as_bool) == Some(true),
        emitted_trace_id: string_value(active.get("emittedTraceId")).map(str::to_owned),
        emitted_audit_event_ids: string_array(active.get("emittedAuditEventIds")),
    })
}

pub fn parse_pending_fusion_children(value: Option<&Value>) -> Vec<CodexPendingFusionChild> {
    let Some(items) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut children = Vec::new();
    for item in items {
        let Some(child) = as_record(item) else {
            continue;
        };
        let Some(parent_tool_call_id) = string_value(child.get("parentToolCallId")) else {
            continue;
        };
        let Some(parent_trace_id) = string_value(child.get("parentTraceId")) else {
            continue;
        };
        let Some(spawned_at_ms) = number_value(child.get("spawnedAtMs")) else {
            continue;
        };
        children.push(CodexPendingFusionChild {
            parent_tool_call_id: parent_tool_call_id.to_owned(),
            parent_trace_id: parent_trace_id.to_owned(),
            spawned_at_ms,
            task_name: string_value(child.get("taskName")).map(str::to_owned),
            agent_path: string_value(child.get("agentPath")).map(str::to_owned),
            child_thread_id: string_value(child.get("childThreadId")).map(str::to_owned),
        });
    }
    children
}

fn parse_input_context(value: Option<&Value>) -> Option<CodexTranscriptInputContext> {
    let context = value.and_then(as_record)?;
    let hash = string_value(context.get("hash"))?.to_owned();
    let range = context.get("deltaRange").and_then(as_record);
    let delta_range = range.and_then(|range| {
        Some(CodexTranscriptSourceRange {
            start_offset: i64_value(range.get("startOffset"))?,
            end_offset: i64_value(range.get("endOffset"))?,
        })
    });
    Some(CodexTranscriptInputContext {
        hash,
        delta: context.get("delta").and_then(Value::as_array).cloned(),
        full_messages: context
            .get("fullMessages")
            .and_then(Value::as_array)
            .cloned(),
        delta_range,
    })
}

fn parse_fork_bootstrap(value: Option<&Value>) -> Option<CodexForkBootstrap> {
    let record = value.and_then(as_record)?;
    let search_offset = number_value(record.get("searchOffset"))?;
    if !search_offset.is_finite() || search_offset < 0.0 {
        return None;
    }
    let state = match record.get("state").and_then(Value::as_str) {
        Some("baseline-tail") => ForkBootstrapState::BaselineTail,
        Some("baseline-search") => ForkBootstrapState::BaselineSearch,
        Some("live-pending") => ForkBootstrapState::LivePending,
        _ if record.get("phase").and_then(Value::as_str) == Some("rebuild-owned-tail") => {
            ForkBootstrapState::BaselineTail
        }
        _ if record.get("mode").and_then(Value::as_str) == Some("baseline") => {
            ForkBootstrapState::BaselineSearch
        }
        _ => ForkBootstrapState::LivePending,
    };
    let tail = parse_active_turn(record.get("tailCandidate"));
    Some(CodexForkBootstrap {
        state,
        search_offset: search_offset as i64,
        initial_turn_id: string_value(record.get("initialTurnId"))
            .or_else(|| string_value(record.get("turnId")))
            .map(str::to_owned),
        recovery_turn_id: string_value(record.get("recoveryTurnId")).map(str::to_owned),
        tail_candidate: if state == ForkBootstrapState::BaselineTail {
            tail
        } else {
            None
        },
    })
}

pub fn create_active_turn(
    turn_id: String,
    start_offset: i64,
    started_at_ms: f64,
    emitted_prompt: bool,
) -> CodexActiveTranscriptTurn {
    CodexActiveTranscriptTurn {
        turn_id,
        start_offset,
        started_at_ms,
        emitted_prompt,
        emitted_step_count: 0,
        ..CodexActiveTranscriptTurn::default()
    }
}

pub fn update_active_turn_metadata(
    active: &mut CodexActiveTranscriptTurn,
    record: &Map<String, Value>,
    payload: &Map<String, Value>,
) {
    if record.get("type").and_then(Value::as_str) != Some("turn_context") {
        return;
    }
    if let Some(model) = string_value(payload.get("model")) {
        active.model = Some(model.to_owned());
    }
    if let Some(cwd) = string_value(payload.get("cwd")) {
        active.cwd = Some(cwd.to_owned());
    }
    if let Some(text) = string_value(payload.get("developer_instructions")) {
        active.developer_instructions = Some(text.to_owned());
    }
}

pub fn update_active_turn_from_extracted(
    active: &mut CodexActiveTranscriptTurn,
    model: &str,
    cwd: Option<&str>,
    developer_instructions: Option<&str>,
) {
    if !model.is_empty() && model != "unknown" {
        active.model = Some(model.to_owned());
    }
    if let Some(cwd) = cwd {
        active.cwd = Some(cwd.to_owned());
    }
    if let Some(text) = developer_instructions {
        active.developer_instructions = Some(text.to_owned());
    }
}

pub fn empty_checkpoint(inode: u64) -> CodexTranscriptCheckpoint {
    CodexTranscriptCheckpoint {
        first_owned_turn_id: None,
        inode,
        scan_offset: 0,
        active_turn: None,
        pending_terminal: None,
        pending_fusion: None,
        pending_subagent: None,
        owner_session_meta_offset: None,
        fork_bootstrap: None,
    }
}

#[cfg(test)]
#[path = "identity_precision_tests.rs"]
mod identity_precision_tests;
