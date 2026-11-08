//! Port of `src/flushers/base-flusher.ts`.

use async_trait::async_trait;
use serde_json::{Map, Value};

use crate::types::AgentActivityEntry;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlushErrorKind {
    Other,
    CodexTurnJournal,
    CodexOutputDurability,
    PendingTraceJournal,
    OutputDurability,
}

#[derive(Debug)]
pub struct FlushError {
    pub message: String,
    pub kind: FlushErrorKind,
}

impl FlushError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            kind: FlushErrorKind::Other,
        }
    }

    pub fn codex_output(backend: &str) -> Self {
        Self {
            message: format!("Codex output was not durably accepted by {backend}"),
            kind: FlushErrorKind::CodexOutputDurability,
        }
    }

    pub fn codex_journal(error: impl std::fmt::Display) -> Self {
        Self {
            message: format!("Codex pending trace journal failed: {error}"),
            kind: FlushErrorKind::CodexTurnJournal,
        }
    }

    pub fn output_durability(agent: &str, backend: &str) -> Self {
        if agent == "Codex" {
            return Self::codex_output(backend);
        }
        Self {
            message: format!("{agent} output was not durably accepted by {backend}"),
            kind: FlushErrorKind::OutputDurability,
        }
    }

    pub fn pending_trace_journal(agent: &str, error: impl std::fmt::Display) -> Self {
        Self {
            message: format!("{agent} pending trace journal failed: {error}"),
            kind: FlushErrorKind::PendingTraceJournal,
        }
    }

    pub fn doubao_journal(error: impl std::fmt::Display) -> Self {
        Self::pending_trace_journal("Doubao Work", error)
    }

    pub fn preserves_checkpoint(&self) -> bool {
        self.kind != FlushErrorKind::Other
    }
}

impl std::fmt::Display for FlushError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for FlushError {}

/// Process-lifetime totals. Removal means leaving the pending buffer.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TraceRuntimeCounters {
    pub removed_buffers_total: u64,
    pub removed_logical_bytes_total: f64,
    pub removed_unmeasured_records_total: u64,
    pub converter_calls_total: u64,
    pub converter_duration_ms_total: f64,
    pub converter_failed_total: u64,
}

/// A periodic view of existing buffers only.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TraceRuntimeSnapshot {
    pub removed_buffers_total: u64,
    pub removed_logical_bytes_total: f64,
    pub removed_unmeasured_records_total: u64,
    pub converter_calls_total: u64,
    pub converter_duration_ms_total: f64,
    pub converter_failed_total: u64,
    pub agent_type: String,
    pub pending_buffers: u64,
    pub pending_records: u64,
    pub pending_logical_bytes: f64,
    pub pending_unmeasured_records: u64,
    pub largest_buffer_logical_bytes: f64,
    pub largest_buffer_records: u64,
    pub largest_buffer_age_ms: u64,
    pub largest_buffer_turn_id: Option<String>,
    pub largest_buffer_session_id: Option<String>,
    pub oldest_buffer_age_ms: u64,
    pub resident_records: Option<u64>,
    pub resident_payload_bytes: Option<u64>,
    pub spilled_buffers: Option<u64>,
    pub spilled_records: Option<u64>,
}

impl TraceRuntimeSnapshot {
    pub fn from_counters(agent_type: &str, counters: &TraceRuntimeCounters) -> Self {
        Self {
            removed_buffers_total: counters.removed_buffers_total,
            removed_logical_bytes_total: counters.removed_logical_bytes_total,
            removed_unmeasured_records_total: counters.removed_unmeasured_records_total,
            converter_calls_total: counters.converter_calls_total,
            converter_duration_ms_total: counters.converter_duration_ms_total,
            converter_failed_total: counters.converter_failed_total,
            agent_type: agent_type.to_string(),
            ..Self::default()
        }
    }
}

#[async_trait]
pub trait BaseFlusher: Send + Sync {
    fn name(&self) -> &str;

    fn uses_prepared_batch(&self) -> bool {
        false
    }

    async fn send(
        &self,
        entry: AgentActivityEntry,
        logical_bytes: Option<f64>,
    ) -> Result<(), FlushError>;

    async fn send_batch(
        &self,
        entries: Vec<AgentActivityEntry>,
        logical_bytes: Option<Vec<f64>>,
    ) -> Result<(), FlushError>;

    /// Callback delivery persists these already serialized activity bytes.
    /// Other protocols retain their existing conversion.
    async fn send_prepared_batch(
        &self,
        entries: Vec<AgentActivityEntry>,
        encoded: Vec<Vec<u8>>,
    ) -> Result<(), FlushError> {
        let lengths = encoded.iter().map(|row| row.len() as f64).collect();
        self.send_batch(entries, Some(lengths)).await
    }

    async fn flush(&self) -> Result<(), FlushError>;

    async fn shutdown(&self) -> Result<(), FlushError>;

    fn trace_runtime_snapshot(&self) -> Vec<TraceRuntimeSnapshot> {
        Vec::new()
    }

    async fn start(&self) -> Result<(), FlushError> {
        Ok(())
    }

    async fn send_raw(
        &self,
        _topic: &str,
        _payload: &Map<String, Value>,
    ) -> Result<(), FlushError> {
        Ok(())
    }
}
