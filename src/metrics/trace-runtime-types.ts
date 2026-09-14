/** Process-lifetime totals. Removal means leaving the pending buffer, not GC. */
export interface TraceRuntimeCounters {
  removed_buffers_total: number;
  removed_logical_bytes_total: number;
  removed_unmeasured_records_total: number;
  converter_calls_total: number;
  converter_duration_ms_total: number;
  converter_failed_total: number;
}

/** A periodic view of existing buffers only; no events or spans are retained. */
export interface TraceRuntimeSnapshot extends TraceRuntimeCounters {
  agent_type: string;
  pending_buffers: number;
  pending_records: number;
  pending_logical_bytes: number;
  pending_unmeasured_records: number;
  largest_buffer_logical_bytes: number;
  largest_buffer_records: number;
  largest_buffer_age_ms: number;
  largest_buffer_turn_id?: string;
  largest_buffer_session_id?: string;
  oldest_buffer_age_ms: number;
}
