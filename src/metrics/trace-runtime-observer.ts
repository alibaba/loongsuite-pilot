import type { RuntimeIdentity } from './runtime-identity.js';
import type {
  SourceBytesBasis,
  SourceReadMeasurement,
  TraceMemorySample,
  TraceRuntimeReleasedRecord,
  TraceRuntimeThresholdRecord,
  TraceRuntimeTurnRecord,
  TraceRuntimeWindowRecord,
  TraceTurnIdentity,
  TraceTurnRelease,
} from './trace-runtime-types.js';

export const TRACE_RUNTIME_DETAIL_QUEUE_LIMIT = 1024;
export const TRACE_RUNTIME_SIZE_THRESHOLDS = [64 * 1024 ** 2, 256 * 1024 ** 2, 1024 ** 3] as const;
export const TRACE_RUNTIME_LIFETIME_THRESHOLDS = [30 * 60_000, 2 * 60 * 60_000] as const;

interface TurnState extends TraceTurnIdentity {
  firstActivityMs: number;
  lastActivityMs: number;
  currentRecords: number;
  currentLogicalBytes: number;
  peakRecords: number;
  peakLogicalBytes: number;
  producedEventBytes: number;
  sourceBytes: number;
  sourceBytesBasis?: SourceBytesBasis;
  sourceAttributionReliable: boolean;
  thresholdBits: number;
}

interface WindowAccumulator {
  agentType: string;
  inputName: string;
  startedAtMs: number;
  activity: boolean;
  sourceBytesTotal: number;
  sourceBytesUnattributed: number;
  producedEventCount: number;
  producedEventBytes: number;
  completedTurnCount: number;
  releasedLogicalBytes: number;
  completedTurnLogicalBytesMax: number;
  sizeBuckets: [number, number, number, number, number, number];
  convertedSpanCount: number;
  convertAttemptCount: number;
  convertDurationTotalMs: number;
  convertDurationMaxMs: number;
  convertFailedCount: number;
  exportTurnCount: number;
  exportDurationTotalMs: number;
  exportDurationMaxMs: number;
  exportFailedTurnCount: number;
  detailDroppedCount: number;
}

export interface TraceRuntimeObserverOptions {
  identity: RuntimeIdentity;
  monotonicNow?: () => number;
  unixNow?: () => number;
  memoryUsage?: () => TraceMemorySample;
  detailQueueLimit?: number;
}

/**
 * Keeps only identifiers and numeric watermarks for the OTLP turn lifecycle.
 * It deliberately cannot accept event records or Span objects.
 */
export class TraceRuntimeObserver {
  private readonly identity: RuntimeIdentity;
  private readonly monotonicNow: () => number;
  private readonly unixNow: () => number;
  private readonly memoryUsage: () => TraceMemorySample;
  private readonly detailQueueLimit: number;
  private readonly turns = new Map<string, TurnState>();
  private readonly windows = new Map<string, WindowAccumulator>();
  private readonly details: TraceRuntimeTurnRecord[] = [];

  constructor(opts: TraceRuntimeObserverOptions) {
    this.identity = opts.identity;
    this.monotonicNow = opts.monotonicNow ?? (() => performance.now());
    this.unixNow = opts.unixNow ?? (() => Date.now());
    this.memoryUsage = opts.memoryUsage ?? (() => {
      const usage = process.memoryUsage();
      return { rssBytes: usage.rss, heapUsedBytes: usage.heapUsed };
    });
    this.detailQueueLimit = Math.max(1, opts.detailQueueLimit ?? TRACE_RUNTIME_DETAIL_QUEUE_LIMIT);
  }

  openTurn(identity: TraceTurnIdentity): void {
    const existing = this.turns.get(identity.bufferKey);
    if (existing) {
      this.updateIdentifiers(existing, identity);
      return;
    }
    const now = this.monotonicNow();
    this.turns.set(identity.bufferKey, {
      ...identity,
      firstActivityMs: now,
      lastActivityMs: now,
      currentRecords: 0,
      currentLogicalBytes: 0,
      peakRecords: 0,
      peakLogicalBytes: 0,
      producedEventBytes: 0,
      sourceBytes: 0,
      sourceAttributionReliable: true,
      thresholdBits: 0,
    });
    this.windowFor(identity.agentType, identity.inputName);
  }

  append(bufferKey: string, logicalBytes: number, identifiers?: Partial<TraceTurnIdentity>): void {
    const turn = this.turns.get(bufferKey);
    if (!turn) return;
    if (identifiers) this.updateIdentifiers(turn, { ...turn, ...identifiers, bufferKey });

    const bytes = finiteNonNegative(logicalBytes);
    turn.currentRecords += 1;
    turn.currentLogicalBytes += bytes;
    turn.producedEventBytes += bytes;
    turn.peakRecords = Math.max(turn.peakRecords, turn.currentRecords);
    turn.peakLogicalBytes = Math.max(turn.peakLogicalBytes, turn.currentLogicalBytes);
    turn.lastActivityMs = this.monotonicNow();

    const window = this.windowFor(turn.agentType, turn.inputName);
    window.activity = true;
    window.producedEventCount += 1;
    window.producedEventBytes += bytes;
    this.checkSizeThresholds(turn);
  }

  recordSourceRead(
    inputName: string,
    measurement: SourceReadMeasurement,
    bufferKey?: string,
  ): void {
    const bytes = finiteNonNegative(measurement.bytes);
    if (bytes === 0) return;
    const window = this.windowFor(measurement.agentType, inputName);
    window.activity = true;
    window.sourceBytesTotal += bytes;

    const turn = bufferKey ? this.turns.get(bufferKey) : undefined;
    const hasTurnIdentity = Boolean(measurement.turnId || measurement.traceId || measurement.sessionId);
    if (!turn || !hasTurnIdentity || turn.agentType !== measurement.agentType || turn.inputName !== inputName) {
      window.sourceBytesUnattributed += bytes;
      return;
    }

    turn.sourceBytes += bytes;
    if (turn.sourceBytesBasis === undefined) {
      turn.sourceBytesBasis = measurement.basis;
    } else if (turn.sourceBytesBasis !== measurement.basis) {
      turn.sourceAttributionReliable = false;
      turn.sourceBytesBasis = undefined;
    }
  }

  checkLifetimeThresholds(): void {
    const now = this.monotonicNow();
    for (const turn of this.turns.values()) {
      const lifetimeMs = Math.max(0, now - turn.firstActivityMs);
      for (let i = 0; i < TRACE_RUNTIME_LIFETIME_THRESHOLDS.length; i++) {
        const bit = 1 << (TRACE_RUNTIME_SIZE_THRESHOLDS.length + i);
        const threshold = TRACE_RUNTIME_LIFETIME_THRESHOLDS[i];
        if (lifetimeMs >= threshold && (turn.thresholdBits & bit) === 0) {
          turn.thresholdBits |= bit;
          this.queueThreshold(turn, 'lifetime_ms', threshold, lifetimeMs);
        }
      }
    }
  }

  releaseTurn(bufferKey: string, release: TraceTurnRelease): void {
    const turn = this.turns.get(bufferKey);
    if (!turn) return;
    const lifetimeMs = Math.max(0, this.monotonicNow() - turn.firstActivityMs);
    const window = this.windowFor(turn.agentType, turn.inputName);
    window.activity = true;
    window.completedTurnCount += 1;
    window.releasedLogicalBytes += turn.currentLogicalBytes;
    window.completedTurnLogicalBytesMax = Math.max(
      window.completedTurnLogicalBytesMax,
      turn.currentLogicalBytes,
    );
    window.sizeBuckets[sizeBucketIndex(turn.currentLogicalBytes)] += 1;

    const processing = release.processing;
    if (processing.convertDurationMs !== undefined || processing.memoryBeforeConvert !== undefined) {
      const duration = finiteNonNegative(processing.convertDurationMs ?? 0);
      window.convertAttemptCount += 1;
      window.convertDurationTotalMs += duration;
      window.convertDurationMaxMs = Math.max(window.convertDurationMaxMs, duration);
    }
    if (processing.convertedSpanCount !== undefined) {
      window.convertedSpanCount += finiteNonNegative(processing.convertedSpanCount);
    }
    if (processing.result === 'convert_failed') window.convertFailedCount += 1;
    if (processing.exportDurationMs !== undefined) {
      const duration = finiteNonNegative(processing.exportDurationMs);
      window.exportTurnCount += 1;
      window.exportDurationTotalMs += duration;
      window.exportDurationMaxMs = Math.max(window.exportDurationMaxMs, duration);
    }
    if (processing.result === 'export_failed') window.exportFailedTurnCount += 1;

    const abnormal = release.releaseReason === 'idle_timeout'
      || release.releaseReason === 'buffer_limit'
      || release.releaseReason === 'shutdown_incomplete'
      || release.releaseReason === 'forced'
      || processing.result !== 'success';
    if (turn.thresholdBits !== 0 || abnormal) {
      this.queueDetail(this.buildReleasedRecord(turn, release, lifetimeMs));
    }
    this.turns.delete(bufferKey);
  }

  drainDetails(): TraceRuntimeTurnRecord[] {
    return this.details.splice(0, this.details.length);
  }

  collectWindows(): TraceRuntimeWindowRecord[] {
    const now = this.monotonicNow();
    const activeByDimension = new Map<string, TurnState[]>();
    for (const turn of this.turns.values()) {
      const key = dimensionKey(turn.agentType, turn.inputName);
      const active = activeByDimension.get(key) ?? [];
      active.push(turn);
      activeByDimension.set(key, active);
      this.windowFor(turn.agentType, turn.inputName);
    }

    const records: TraceRuntimeWindowRecord[] = [];
    for (const [key, window] of this.windows) {
      const active = activeByDimension.get(key) ?? [];
      if (!window.activity && active.length === 0) continue;
      let recordsCurrent = 0;
      let bytesCurrent = 0;
      let largest: TurnState | undefined;
      let oldestLifetimeMs = 0;
      for (const turn of active) {
        recordsCurrent += turn.currentRecords;
        bytesCurrent += turn.currentLogicalBytes;
        if (!largest || turn.currentLogicalBytes > largest.currentLogicalBytes) largest = turn;
        oldestLifetimeMs = Math.max(oldestLifetimeMs, Math.max(0, now - turn.firstActivityMs));
      }
      records.push({
        ...this.common(window.agentType, window.inputName, 'window'),
        window_ms: Math.max(0, Math.round(now - window.startedAtMs)),
        source_bytes_total: window.sourceBytesTotal,
        source_bytes_unattributed: window.sourceBytesUnattributed,
        produced_event_count_total: window.producedEventCount,
        produced_event_bytes_total: window.producedEventBytes,
        active_turn_count: active.length,
        buffer_records_current: recordsCurrent,
        buffer_logical_bytes_current: bytesCurrent,
        ...(largest?.sessionId ? { largest_active_session_id: largest.sessionId } : {}),
        ...(largest?.turnId ? { largest_active_turn_id: largest.turnId } : {}),
        ...(largest?.traceId ? { largest_active_trace_id: largest.traceId } : {}),
        largest_active_turn_logical_bytes: largest?.currentLogicalBytes ?? 0,
        oldest_active_turn_lifetime_ms: Math.round(oldestLifetimeMs),
        completed_turn_count: window.completedTurnCount,
        released_logical_bytes_total: window.releasedLogicalBytes,
        completed_turn_logical_bytes_max: window.completedTurnLogicalBytesMax,
        completed_turn_le_1m_count: window.sizeBuckets[0],
        completed_turn_1m_to_16m_count: window.sizeBuckets[1],
        completed_turn_16m_to_64m_count: window.sizeBuckets[2],
        completed_turn_64m_to_256m_count: window.sizeBuckets[3],
        completed_turn_256m_to_1g_count: window.sizeBuckets[4],
        completed_turn_gt_1g_count: window.sizeBuckets[5],
        converted_span_count_total: window.convertedSpanCount,
        convert_attempt_count: window.convertAttemptCount,
        convert_duration_ms_total: window.convertDurationTotalMs,
        convert_duration_ms_max: window.convertDurationMaxMs,
        convert_failed_count: window.convertFailedCount,
        export_turn_count: window.exportTurnCount,
        export_duration_ms_total: window.exportDurationTotalMs,
        export_duration_ms_max: window.exportDurationMaxMs,
        export_failed_turn_count: window.exportFailedTurnCount,
        detail_dropped_count: window.detailDroppedCount,
      });
      this.windows.set(key, newWindow(window.agentType, window.inputName, now));
    }
    return records;
  }

  private checkSizeThresholds(turn: TurnState): void {
    const lifetimeMs = Math.max(0, turn.lastActivityMs - turn.firstActivityMs);
    for (let i = 0; i < TRACE_RUNTIME_SIZE_THRESHOLDS.length; i++) {
      const bit = 1 << i;
      const threshold = TRACE_RUNTIME_SIZE_THRESHOLDS[i];
      if (turn.currentLogicalBytes >= threshold && (turn.thresholdBits & bit) === 0) {
        turn.thresholdBits |= bit;
        this.queueThreshold(turn, 'buffer_logical_bytes', threshold, lifetimeMs);
      }
    }
  }

  private queueThreshold(
    turn: TurnState,
    kind: TraceRuntimeThresholdRecord['threshold_kind'],
    value: number,
    lifetimeMs: number,
  ): void {
    const memory = this.safeMemoryUsage();
    const source = sourceFields(turn);
    this.queueDetail({
      ...this.common(turn.agentType, turn.inputName, 'turn'),
      event: 'threshold_crossed',
      ...identifierFields(turn),
      threshold_kind: kind,
      threshold_value: value,
      lifetime_ms: Math.round(lifetimeMs),
      ...source,
      produced_event_bytes_total: turn.producedEventBytes,
      buffer_records_current: turn.currentRecords,
      buffer_logical_bytes_current: turn.currentLogicalBytes,
      peak_buffer_records: turn.peakRecords,
      peak_buffer_logical_bytes: turn.peakLogicalBytes,
      rss_bytes: memory.rssBytes,
      heap_used_bytes: memory.heapUsedBytes,
    });
  }

  private buildReleasedRecord(
    turn: TurnState,
    release: TraceTurnRelease,
    lifetimeMs: number,
  ): TraceRuntimeReleasedRecord {
    const processing = release.processing;
    return {
      ...this.common(turn.agentType, turn.inputName, 'turn'),
      event: 'released',
      ...identifierFields(turn),
      release_reason: release.releaseReason,
      boundary_signal: release.boundarySignal,
      lifetime_ms: Math.round(lifetimeMs),
      ...sourceFields(turn),
      produced_event_bytes_total: turn.producedEventBytes,
      peak_buffer_records: turn.peakRecords,
      peak_buffer_logical_bytes: turn.peakLogicalBytes,
      released_logical_bytes: turn.currentLogicalBytes,
      ...(processing.convertedSpanCount !== undefined
        ? { converted_span_count: finiteNonNegative(processing.convertedSpanCount) }
        : {}),
      ...(processing.convertDurationMs !== undefined
        ? { convert_duration_ms: finiteNonNegative(processing.convertDurationMs) }
        : {}),
      ...(processing.exportDurationMs !== undefined
        ? { export_duration_ms: finiteNonNegative(processing.exportDurationMs) }
        : {}),
      ...(processing.memoryBeforeConvert
        ? {
            rss_before_convert_bytes: processing.memoryBeforeConvert.rssBytes,
            heap_used_before_convert_bytes: processing.memoryBeforeConvert.heapUsedBytes,
          }
        : {}),
      ...(processing.memoryAfterConvert
        ? {
            rss_after_convert_bytes: processing.memoryAfterConvert.rssBytes,
            heap_used_after_convert_bytes: processing.memoryAfterConvert.heapUsedBytes,
          }
        : {}),
      result: processing.result,
    };
  }

  private queueDetail(record: TraceRuntimeTurnRecord): void {
    if (this.details.length >= this.detailQueueLimit) {
      const dropped = this.details.shift();
      if (dropped) {
        const window = this.windowFor(dropped.agent_type, dropped.input_name);
        window.activity = true;
        window.detailDroppedCount += 1;
      }
    }
    this.details.push(record);
  }

  private safeMemoryUsage(): TraceMemorySample {
    try {
      const sample = this.memoryUsage();
      return {
        rssBytes: finiteNonNegative(sample.rssBytes),
        heapUsedBytes: finiteNonNegative(sample.heapUsedBytes),
      };
    } catch {
      return { rssBytes: 0, heapUsedBytes: 0 };
    }
  }

  private common<T extends 'window' | 'turn'>(
    agentType: string,
    inputName: string,
    recordType: T,
  ) {
    return {
      schema_version: 1 as const,
      version: this.identity.version,
      run_id: this.identity.runId,
      instance_id: this.identity.instanceId,
      user_id: this.identity.userId,
      agent_type: agentType,
      input_name: inputName,
      record_type: recordType,
      __time__: Math.floor(this.unixNow() / 1000),
    };
  }

  private updateIdentifiers(turn: TurnState, identity: TraceTurnIdentity): void {
    if (!turn.sessionId && identity.sessionId) turn.sessionId = identity.sessionId;
    if (!turn.turnId && identity.turnId) turn.turnId = identity.turnId;
    if (!turn.traceId && identity.traceId) turn.traceId = identity.traceId;
  }

  private windowFor(agentType: string, inputName: string): WindowAccumulator {
    const key = dimensionKey(agentType, inputName);
    let window = this.windows.get(key);
    if (!window) {
      window = newWindow(agentType, inputName, this.monotonicNow());
      this.windows.set(key, window);
    }
    return window;
  }
}

function dimensionKey(agentType: string, inputName: string): string {
  return `${agentType}\u0000${inputName}`;
}

function newWindow(agentType: string, inputName: string, startedAtMs: number): WindowAccumulator {
  return {
    agentType,
    inputName,
    startedAtMs,
    activity: false,
    sourceBytesTotal: 0,
    sourceBytesUnattributed: 0,
    producedEventCount: 0,
    producedEventBytes: 0,
    completedTurnCount: 0,
    releasedLogicalBytes: 0,
    completedTurnLogicalBytesMax: 0,
    sizeBuckets: [0, 0, 0, 0, 0, 0],
    convertedSpanCount: 0,
    convertAttemptCount: 0,
    convertDurationTotalMs: 0,
    convertDurationMaxMs: 0,
    convertFailedCount: 0,
    exportTurnCount: 0,
    exportDurationTotalMs: 0,
    exportDurationMaxMs: 0,
    exportFailedTurnCount: 0,
    detailDroppedCount: 0,
  };
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function sizeBucketIndex(bytes: number): 0 | 1 | 2 | 3 | 4 | 5 {
  if (bytes <= 1024 ** 2) return 0;
  if (bytes <= 16 * 1024 ** 2) return 1;
  if (bytes <= 64 * 1024 ** 2) return 2;
  if (bytes <= 256 * 1024 ** 2) return 3;
  if (bytes <= 1024 ** 3) return 4;
  return 5;
}

function identifierFields(turn: TurnState): {
  session_id?: string;
  turn_id?: string;
  trace_id?: string;
} {
  return {
    ...(turn.sessionId ? { session_id: turn.sessionId } : {}),
    ...(turn.turnId ? { turn_id: turn.turnId } : {}),
    ...(turn.traceId ? { trace_id: turn.traceId } : {}),
  };
}

function sourceFields(turn: TurnState): {
  source_bytes_total?: number;
  source_bytes_basis?: SourceBytesBasis;
} {
  if (!turn.sourceAttributionReliable || turn.sourceBytes <= 0 || !turn.sourceBytesBasis) return {};
  return {
    source_bytes_total: turn.sourceBytes,
    source_bytes_basis: turn.sourceBytesBasis,
  };
}
