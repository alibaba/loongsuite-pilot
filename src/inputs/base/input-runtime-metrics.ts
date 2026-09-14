import { performance } from 'node:perf_hooks';

export const PRIMARY_INPUT_SOURCE_KIND = 'primary' as const;
export type InputSourceKind = typeof PRIMARY_INPUT_SOURCE_KIND;

/** One collect cycle's fixed-size, payload-free Input observability delta. */
export interface InputRuntimeDelta {
  sourceKind: InputSourceKind;
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

  observeRead(bytesRead: number, requestedBytes: number, durationMs: number): void {
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
    return {
      sourceKind: PRIMARY_INPUT_SOURCE_KIND,
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
