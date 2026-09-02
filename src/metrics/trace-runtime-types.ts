export type SourceBytesBasis = 'bytes_read' | 'offset_delta';

export interface SourceReadMeasurement {
  agentType: string;
  sessionId?: string;
  turnId?: string;
  traceId?: string;
  bytes: number;
  basis: SourceBytesBasis;
}

export interface InputEntriesMetadata {
  sourceReads?: readonly SourceReadMeasurement[];
}

export interface InputCollectionBatch {
  entries: import('../types/index.js').AgentActivityEntry[];
  metadata?: InputEntriesMetadata;
}

export interface FlusherEntryContext {
  inputName: string;
  entryLogicalBytes?: number;
  sourceReads?: readonly SourceReadMeasurement[];
}

export interface FlusherBatchContext {
  inputName: string;
  entryLogicalBytes?: readonly number[];
  sourceReads?: readonly SourceReadMeasurement[];
}

export type TraceReleaseReason =
  | 'terminal'
  | 'group_successor'
  | 'idle_timeout'
  | 'buffer_limit'
  | 'shutdown_incomplete'
  | 'forced';

export type TraceRuntimeResult = 'success' | 'convert_failed' | 'export_failed';

export interface TraceMemorySample {
  rssBytes: number;
  heapUsedBytes: number;
}

export interface TraceProcessSummary {
  result: TraceRuntimeResult;
  convertedSpanCount?: number;
  convertDurationMs?: number;
  exportDurationMs?: number;
  memoryBeforeConvert?: TraceMemorySample;
  memoryAfterConvert?: TraceMemorySample;
}

export interface TraceTurnIdentity {
  bufferKey: string;
  agentType: string;
  inputName: string;
  sessionId?: string;
  turnId?: string;
  traceId?: string;
}

export interface TraceTurnRelease {
  releaseReason: TraceReleaseReason;
  boundarySignal: string;
  processing: TraceProcessSummary;
}

export interface TraceRuntimeCommonRecord {
  schema_version: 1;
  version: string;
  run_id: string;
  instance_id: string;
  user_id: string;
  agent_type: string;
  input_name: string;
  record_type: 'window' | 'turn';
  __time__: number;
}

export interface TraceRuntimeWindowRecord extends TraceRuntimeCommonRecord {
  record_type: 'window';
  window_ms: number;
  source_bytes_total: number;
  source_bytes_unattributed: number;
  produced_event_count_total: number;
  produced_event_bytes_total: number;
  active_turn_count: number;
  buffer_records_current: number;
  buffer_logical_bytes_current: number;
  largest_active_session_id?: string;
  largest_active_turn_id?: string;
  largest_active_trace_id?: string;
  largest_active_turn_logical_bytes: number;
  oldest_active_turn_lifetime_ms: number;
  completed_turn_count: number;
  released_logical_bytes_total: number;
  completed_turn_logical_bytes_max: number;
  completed_turn_le_1m_count: number;
  completed_turn_1m_to_16m_count: number;
  completed_turn_16m_to_64m_count: number;
  completed_turn_64m_to_256m_count: number;
  completed_turn_256m_to_1g_count: number;
  completed_turn_gt_1g_count: number;
  converted_span_count_total: number;
  convert_attempt_count: number;
  convert_duration_ms_total: number;
  convert_duration_ms_max: number;
  convert_failed_count: number;
  export_turn_count: number;
  export_duration_ms_total: number;
  export_duration_ms_max: number;
  export_failed_turn_count: number;
  detail_dropped_count: number;
}

export interface TraceRuntimeThresholdRecord extends TraceRuntimeCommonRecord {
  record_type: 'turn';
  event: 'threshold_crossed';
  session_id?: string;
  turn_id?: string;
  trace_id?: string;
  threshold_kind: 'buffer_logical_bytes' | 'lifetime_ms';
  threshold_value: number;
  lifetime_ms: number;
  source_bytes_total?: number;
  source_bytes_basis?: SourceBytesBasis;
  produced_event_bytes_total: number;
  buffer_records_current: number;
  buffer_logical_bytes_current: number;
  peak_buffer_records: number;
  peak_buffer_logical_bytes: number;
  rss_bytes: number;
  heap_used_bytes: number;
}

export interface TraceRuntimeReleasedRecord extends TraceRuntimeCommonRecord {
  record_type: 'turn';
  event: 'released';
  session_id?: string;
  turn_id?: string;
  trace_id?: string;
  release_reason: TraceReleaseReason;
  boundary_signal: string;
  lifetime_ms: number;
  source_bytes_total?: number;
  source_bytes_basis?: SourceBytesBasis;
  produced_event_bytes_total: number;
  peak_buffer_records: number;
  peak_buffer_logical_bytes: number;
  released_logical_bytes: number;
  converted_span_count?: number;
  convert_duration_ms?: number;
  export_duration_ms?: number;
  rss_before_convert_bytes?: number;
  rss_after_convert_bytes?: number;
  heap_used_before_convert_bytes?: number;
  heap_used_after_convert_bytes?: number;
  result: TraceRuntimeResult;
}

export type TraceRuntimeTurnRecord =
  | TraceRuntimeThresholdRecord
  | TraceRuntimeReleasedRecord;

export type TraceRuntimeRecord = TraceRuntimeWindowRecord | TraceRuntimeTurnRecord;
