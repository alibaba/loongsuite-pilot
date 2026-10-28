import { performance } from 'node:perf_hooks';

export const PRIMARY_INPUT_SOURCE_KIND = 'primary' as const;
export type InputSourceKind = typeof PRIMARY_INPUT_SOURCE_KIND;

export const CODEX_READ_REASONS = [
  'owner_probe', 'fork_search', 'normal_scan', 'recovery',
  'hydrate', 'baseline', 'integrity_check',
] as const;
export type CodexReadReason = typeof CODEX_READ_REASONS[number];

/** Fixed-size optional diagnostics; never keyed by a source path or session. */
export interface CodexReadMetrics {
  readBytes: Record<CodexReadReason, number>;
  readCalls: Record<CodexReadReason, number>;
  budgetDeferredTasks: number;
  ownerBlockedFilesMax: number;
  sourceConflictFilesMax: number;
  parseSliceOverruns: number;
  eligibleWaitMsMax: number;
}

export type CodexReadMetricFields = Partial<Record<
  `raw_read_bytes_${CodexReadReason}` | `raw_read_calls_${CodexReadReason}`
  | 'budget_deferred_tasks' | 'owner_blocked_files_max' | 'source_conflict_files_max'
  | 'parse_slice_overruns' | 'eligible_wait_ms_max', string
>>;

export function createCodexReadMetrics(): CodexReadMetrics {
  const zeroReasons = (): Record<CodexReadReason, number> => ({
    owner_probe: 0, fork_search: 0, normal_scan: 0, recovery: 0,
    hydrate: 0, baseline: 0, integrity_check: 0,
  });
  return {
    readBytes: zeroReasons(), readCalls: zeroReasons(),
    budgetDeferredTasks: 0, ownerBlockedFilesMax: 0, sourceConflictFilesMax: 0,
    parseSliceOverruns: 0, eligibleWaitMsMax: 0,
  };
}

export function cloneCodexReadMetrics(value: CodexReadMetrics): CodexReadMetrics {
  return { ...value, readBytes: { ...value.readBytes }, readCalls: { ...value.readCalls } };
}

export function mergeCodexReadMetrics(target: CodexReadMetrics, value: CodexReadMetrics): void {
  for (const reason of CODEX_READ_REASONS) {
    target.readBytes[reason] += finiteCount(value.readBytes[reason]);
    target.readCalls[reason] += finiteCount(value.readCalls[reason]);
  }
  target.budgetDeferredTasks += finiteCount(value.budgetDeferredTasks);
  target.parseSliceOverruns += finiteCount(value.parseSliceOverruns);
  target.ownerBlockedFilesMax = Math.max(target.ownerBlockedFilesMax, finiteCount(value.ownerBlockedFilesMax));
  target.sourceConflictFilesMax = Math.max(target.sourceConflictFilesMax, finiteCount(value.sourceConflictFilesMax));
  target.eligibleWaitMsMax = Math.max(target.eligibleWaitMsMax, finiteNonNegative(value.eligibleWaitMsMax));
}

export function resetCodexReadWindowMaxima(value: CodexReadMetrics): void {
  value.ownerBlockedFilesMax = 0;
  value.sourceConflictFilesMax = 0;
  value.eligibleWaitMsMax = 0;
}

/** Summed fields are cumulative deltas; maxima already belong to the sampled window. */
export function codexReadMetricFields(value: CodexReadMetrics, baseline?: CodexReadMetrics): CodexReadMetricFields {
  const fields: CodexReadMetricFields = {};
  const delta = (current: number, previous = 0): string => String(
    Math.max(0, finiteCount(current) - finiteCount(previous)),
  );
  for (const reason of CODEX_READ_REASONS) {
    fields[`raw_read_bytes_${reason}`] = delta(value.readBytes[reason], baseline?.readBytes[reason]);
    fields[`raw_read_calls_${reason}`] = delta(value.readCalls[reason], baseline?.readCalls[reason]);
  }
  fields.budget_deferred_tasks = delta(value.budgetDeferredTasks, baseline?.budgetDeferredTasks);
  fields.parse_slice_overruns = delta(value.parseSliceOverruns, baseline?.parseSliceOverruns);
  fields.owner_blocked_files_max = String(finiteCount(value.ownerBlockedFilesMax));
  fields.source_conflict_files_max = String(finiteCount(value.sourceConflictFilesMax));
  fields.eligible_wait_ms_max = String(finiteNonNegative(value.eligibleWaitMsMax));
  return fields;
}

// Non-Codex accumulators retain their existing scalar-only state and allocation cost.
const codexReadObservers = new WeakMap<InputRuntimeAccumulator, CodexReadMetrics>();

/** One collect cycle's fixed-size, payload-free Input observability delta. */
export interface InputRuntimeDelta {
  sourceKind: InputSourceKind;
  codexRead?: CodexReadMetrics;
  rawReadCalls: number;
  rawReadBytes: number;
  rawInRecords: number;
  rawInBytes: number;
  rawInMaxBatchBytes: number;
  rawInMaxRecordBytes: number;
  rawBacklogBytesMax: number;
  parseSuccessRecords: number;
  parseFailedRecords: number;
  readDurationMs: number;
  processDurationMs: number;
}

export interface CommittedInputBatch {
  bytes: number;
  records: number;
  parseSuccessRecords: number;
  parseFailedRecords: number;
  maxRecordBytes: number;
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function finiteCount(value: number): number {
  return Math.trunc(finiteNonNegative(value));
}

/**
 * Mutable per-collect accumulator. It stores only scalar numbers and is never
 * retained after the cycle emits its delta.
 */
export class InputRuntimeAccumulator {
  private rawReadCalls = 0;
  private rawReadBytes = 0;
  private rawInRecords = 0;
  private rawInBytes = 0;
  private rawInMaxBatchBytes = 0;
  private rawInMaxRecordBytes = 0;
  private rawBacklogBytesMax = 0;
  private parseSuccessRecords = 0;
  private parseFailedRecords = 0;
  private readDurationMs = 0;

  now(): number {
    return performance.now();
  }

  enableCodexReadMetrics(): void {
    if (!codexReadObservers.has(this)) codexReadObservers.set(this, createCodexReadMetrics());
  }

  observeCodexWork(value: Partial<Omit<CodexReadMetrics, 'readBytes' | 'readCalls'>>): void {
    this.enableCodexReadMetrics();
    const metrics = codexReadObservers.get(this)!;
    metrics.budgetDeferredTasks += finiteCount(value.budgetDeferredTasks ?? 0);
    metrics.parseSliceOverruns += finiteCount(value.parseSliceOverruns ?? 0);
    metrics.ownerBlockedFilesMax = Math.max(metrics.ownerBlockedFilesMax, finiteCount(value.ownerBlockedFilesMax ?? 0));
    metrics.sourceConflictFilesMax = Math.max(metrics.sourceConflictFilesMax, finiteCount(value.sourceConflictFilesMax ?? 0));
    metrics.eligibleWaitMsMax = Math.max(metrics.eligibleWaitMsMax, finiteNonNegative(value.eligibleWaitMsMax ?? 0));
  }

  observeRead(bytesRead: number, requestedBytes: number, durationMs: number, reason?: CodexReadReason): void {
    if (reason !== undefined) {
      this.enableCodexReadMetrics();
      const metrics = codexReadObservers.get(this)!;
      metrics.readCalls[reason]++;
      metrics.readBytes[reason] += finiteCount(bytesRead);
    }
    this.rawReadCalls++;
    this.rawReadBytes += finiteCount(bytesRead);
    this.rawInMaxBatchBytes = Math.max(
      this.rawInMaxBatchBytes,
      finiteCount(requestedBytes),
    );
    this.readDurationMs += finiteNonNegative(durationMs);
  }

  observeCommittedBatch(batch: CommittedInputBatch): void {
    this.rawInBytes += finiteCount(batch.bytes);
    this.rawInRecords += finiteCount(batch.records);
    this.parseSuccessRecords += finiteCount(batch.parseSuccessRecords);
    this.parseFailedRecords += finiteCount(batch.parseFailedRecords);
    this.rawInMaxRecordBytes = Math.max(
      this.rawInMaxRecordBytes,
      finiteCount(batch.maxRecordBytes),
    );
  }

  observeBacklog(bytes: number): void {
    this.rawBacklogBytesMax = Math.max(this.rawBacklogBytesMax, finiteCount(bytes));
  }

  finish(collectDurationMs: number): InputRuntimeDelta {
    // Non-read wall time intentionally includes discovery, parsing, filtering,
    // enrichment and conversion. It is not presented as pure CPU time.
    const processDurationMs = Math.max(
      0,
      finiteNonNegative(collectDurationMs) - this.readDurationMs,
    );
    const codexRead = codexReadObservers.get(this);
    return {
      sourceKind: PRIMARY_INPUT_SOURCE_KIND,
      ...(codexRead ? { codexRead: cloneCodexReadMetrics(codexRead) } : {}),
      rawReadCalls: this.rawReadCalls,
      rawReadBytes: this.rawReadBytes,
      rawInRecords: this.rawInRecords,
      rawInBytes: this.rawInBytes,
      rawInMaxBatchBytes: this.rawInMaxBatchBytes,
      rawInMaxRecordBytes: this.rawInMaxRecordBytes,
      rawBacklogBytesMax: this.rawBacklogBytesMax,
      parseSuccessRecords: this.parseSuccessRecords,
      parseFailedRecords: this.parseFailedRecords,
      readDurationMs: this.readDurationMs,
      processDurationMs,
    };
  }
}
