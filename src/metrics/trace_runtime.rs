//! Process-lifetime trace buffer counters. Removal means leaving the pending buffer.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct TraceRuntimeCounters {
    pub removed_buffers_total: u64,
    pub removed_logical_bytes_total: u64,
    pub removed_unmeasured_records_total: u64,
    pub converter_calls_total: u64,
    pub converter_duration_ms_total: u64,
    pub converter_failed_total: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TraceRuntimeSnapshot {
    pub agent_type: String,
    pub pending_buffers: u64,
    pub pending_records: u64,
    pub pending_logical_bytes: u64,
    pub pending_unmeasured_records: u64,
    pub largest_buffer_logical_bytes: u64,
    pub largest_buffer_records: u64,
    pub largest_buffer_age_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub largest_buffer_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub largest_buffer_session_id: Option<String>,
    pub oldest_buffer_age_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resident_records: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resident_payload_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spilled_buffers: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spilled_records: Option<u64>,
    pub removed_buffers_total: u64,
    pub removed_logical_bytes_total: u64,
    pub removed_unmeasured_records_total: u64,
    pub converter_calls_total: u64,
    pub converter_duration_ms_total: u64,
    pub converter_failed_total: u64,
}

impl From<crate::flushers::TraceRuntimeSnapshot> for TraceRuntimeSnapshot {
    fn from(row: crate::flushers::TraceRuntimeSnapshot) -> Self {
        Self {
            agent_type: row.agent_type,
            pending_buffers: row.pending_buffers,
            pending_records: row.pending_records,
            pending_logical_bytes: row.pending_logical_bytes as u64,
            pending_unmeasured_records: row.pending_unmeasured_records,
            largest_buffer_logical_bytes: row.largest_buffer_logical_bytes as u64,
            largest_buffer_records: row.largest_buffer_records,
            largest_buffer_age_ms: row.largest_buffer_age_ms,
            largest_buffer_turn_id: row.largest_buffer_turn_id,
            largest_buffer_session_id: row.largest_buffer_session_id,
            oldest_buffer_age_ms: row.oldest_buffer_age_ms,
            resident_records: row.resident_records,
            resident_payload_bytes: row.resident_payload_bytes,
            spilled_buffers: row.spilled_buffers,
            spilled_records: row.spilled_records,
            removed_buffers_total: row.removed_buffers_total,
            removed_logical_bytes_total: row.removed_logical_bytes_total as u64,
            removed_unmeasured_records_total: row.removed_unmeasured_records_total,
            converter_calls_total: row.converter_calls_total,
            converter_duration_ms_total: row.converter_duration_ms_total as u64,
            converter_failed_total: row.converter_failed_total,
        }
    }
}
