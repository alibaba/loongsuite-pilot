//! Qoder root context materialization. Native spans already use real roots;
//! match the util's turn-level trace/upstream selection without SDK handler
//! overrides or mutation of audit entries or exported SDK span objects.
use indexmap::IndexMap;
use std::collections::HashSet;

use super::otlp_json_serializer::{ConvertOptions, ConvertResult, EventLogConverter};
use super::span_id_reservation::{valid_span_id, valid_trace_id};
use crate::types::{AgentActivityEntry, AgentEventName};

pub const QODER_TRANSCRIPT_AGENT_TYPES: &[&str] = &["qoder", "qoder-cli", "qoder-cn", "qoder-idea"];

pub(super) fn is_qoder_transcript_agent(agent_type: &str) -> bool {
    QODER_TRANSCRIPT_AGENT_TYPES.contains(&crate::utils::normalize_agent_type(agent_type).as_str())
}
fn turn_key(record: &AgentActivityEntry) -> String {
    if let Some(turn) = record.turn_id.as_deref().filter(|turn| !turn.is_empty()) {
        format!("turn:{turn}")
    } else if !record.session_id.is_empty() {
        format!("session:{}", record.session_id)
    } else {
        "__no_turn__".into()
    }
}
pub(super) fn entry_upstream_parent(records: &[&AgentActivityEntry]) -> Option<String> {
    // Internal LLM/TOOL parent IDs belong to STEP edges. Even000...001 is a
    // genuine upstream when explicitly supplied by an other/user-input marker.
    records
        .iter()
        .filter(|record| record.event_name == Some(AgentEventName::Other))
        .find_map(|record| {
            record
                .parent_span_id
                .as_deref()
                .filter(|id| valid_span_id(id))
        })
        .map(str::to_string)
}
pub fn convert_qoder_turn(
    records: &[AgentActivityEntry],
    options: &ConvertOptions,
    converter: &dyn EventLogConverter,
) -> Result<ConvertResult, String> {
    let mut traces: IndexMap<String, Option<String>> = IndexMap::new();
    let mut warnings = Vec::new();
    let mut warned = HashSet::new();
    for record in records {
        let key = turn_key(record);
        let chosen = traces.entry(key.clone()).or_default();
        if let Some(trace) = record
            .trace_id
            .as_deref()
            .filter(|trace| valid_trace_id(trace))
        {
            if let Some(first) = chosen.as_deref() {
                if first != trace && warned.insert((key, trace.to_string())) {
                    warnings.push(format!(
                        "Inconsistent trace_id within turn {}: kept {first}, saw {trace}",
                        record.turn_id.as_deref().unwrap_or("(no turn.id)")
                    ));
                }
            } else {
                *chosen = Some(trace.into());
            }
        }
    }
    // The native shared converter partitions by concrete trace. Fill the
    // turn's selected context in copies before span creation, so a user marker
    // lacking trace_id cannot create a second unrelated ENTRY.
    let mut prepared = records.to_vec();
    for record in &mut prepared {
        if let Some(Some(trace)) = traces.get(&turn_key(record)) {
            record.trace_id = Some(trace.clone());
        }
    }
    let mut result = converter.convert(&prepared, options)?;
    result.warnings.extend(warnings);
    Ok(result)
}
