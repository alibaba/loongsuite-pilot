import { describe, expect, it } from 'vitest';
import {
  InputRuntimeAccumulator, CODEX_READ_REASONS, cloneCodexReadMetrics,
  createCodexReadMetrics, mergeCodexReadMetrics, resetCodexReadWindowMaxima,
  codexReadMetricFields,
} from '../../../src/inputs/base/input-runtime-metrics.js';

describe('InputRuntimeAccumulator', () => {
  it('attributes Codex reads once without changing the primary source or consumed volume', () => {
    const accumulator = new InputRuntimeAccumulator();
    accumulator.enableCodexReadMetrics();
    for (const [index, reason] of CODEX_READ_REASONS.entries()) accumulator.observeRead(index, 32, 1, reason);
    accumulator.observeRead(0, 32, 1, 'recovery');
    accumulator.observeCodexWork({ budgetDeferredTasks: 2, ownerBlockedFilesMax: 3, eligibleWaitMsMax: 1.5 });
    accumulator.observeCodexWork({ budgetDeferredTasks: 1, ownerBlockedFilesMax: 1, eligibleWaitMsMax: 0.5 });
    const result = accumulator.finish(10);
    expect(result.sourceKind).toBe('primary');
    expect(result.rawInBytes).toBe(0);
    expect(Object.values(result.codexRead!.readBytes).reduce((sum, count) => sum + count, 0)).toBe(result.rawReadBytes);
    expect(Object.values(result.codexRead!.readCalls).reduce((sum, count) => sum + count, 0)).toBe(result.rawReadCalls);
    expect(result.codexRead).toMatchObject({ budgetDeferredTasks: 3, ownerBlockedFilesMax: 3, eligibleWaitMsMax: 1.5 });
    result.codexRead!.readBytes.recovery = 10_000;
    expect(accumulator.finish(10).codexRead!.readBytes.recovery).toBe(3);
    expect(new InputRuntimeAccumulator().finish(0)).not.toHaveProperty('codexRead');
  });

  it('separates cumulative Codex sums from sampled window maxima', () => {
    const totals = createCodexReadMetrics();
    const first = createCodexReadMetrics();
    first.readBytes.owner_probe = 20;
    first.readCalls.owner_probe = 1;
    first.budgetDeferredTasks = 2;
    first.ownerBlockedFilesMax = 4;
    mergeCodexReadMetrics(totals, first);
    const baseline = cloneCodexReadMetrics(totals);
    resetCodexReadWindowMaxima(totals);
    const second = createCodexReadMetrics();
    second.readBytes.recovery = 10;
    second.readCalls.recovery = 1;
    second.ownerBlockedFilesMax = 1;
    second.eligibleWaitMsMax = 2.5;
    mergeCodexReadMetrics(totals, second);
    expect(baseline.ownerBlockedFilesMax).toBe(4);
    expect(codexReadMetricFields(totals, baseline)).toMatchObject({
      raw_read_bytes_owner_probe: '0', raw_read_bytes_recovery: '10',
      raw_read_calls_recovery: '1', budget_deferred_tasks: '0',
      owner_blocked_files_max: '1', eligible_wait_ms_max: '2.5',
    });
    const malformed = createCodexReadMetrics();
    malformed.readBytes.hydrate = Number.NaN;
    malformed.parseSliceOverruns = -1;
    malformed.eligibleWaitMsMax = Number.POSITIVE_INFINITY;
    mergeCodexReadMetrics(totals, malformed);
    expect(totals.readBytes.hydrate).toBe(0);
    expect(totals.parseSliceOverruns).toBe(0);
    expect(totals.eligibleWaitMsMax).toBe(2.5);
  });

  it('keeps scalar sum/max state and separates read from process wall time', () => {
    const accumulator = new InputRuntimeAccumulator();
    accumulator.observeRead(80, 128, 2.5);
    accumulator.observeRead(20, 32, 0.5);
    accumulator.observeBacklog(300);
    accumulator.observeBacklog(120);
    accumulator.observeCommittedBatch({
      bytes: 90,
      records: 2,
      parseSuccessRecords: 1,
      parseFailedRecords: 1,
      maxRecordBytes: 60,
    });

    expect(accumulator.finish(10)).toEqual({
      sourceKind: 'primary',
      rawReadCalls: 2,
      rawReadBytes: 100,
      rawInRecords: 2,
      rawInBytes: 90,
      rawInMaxBatchBytes: 128,
      rawInMaxRecordBytes: 60,
      rawBacklogBytesMax: 300,
      parseSuccessRecords: 1,
      parseFailedRecords: 1,
      readDurationMs: 3,
      processDurationMs: 7,
    });
  });

  it('normalizes negative and non-finite observations without retaining payloads', () => {
    const accumulator = new InputRuntimeAccumulator();
    accumulator.observeRead(Number.NaN, Number.POSITIVE_INFINITY, -1);
    accumulator.observeCommittedBatch({
      bytes: -1,
      records: Number.NaN,
      parseSuccessRecords: -2,
      parseFailedRecords: Number.POSITIVE_INFINITY,
      maxRecordBytes: -3,
    });
    accumulator.observeBacklog(Number.NaN);

    expect(accumulator.finish(-1)).toMatchObject({
      rawReadCalls: 1,
      rawReadBytes: 0,
      rawInRecords: 0,
      rawInBytes: 0,
      rawInMaxBatchBytes: 0,
      rawInMaxRecordBytes: 0,
      rawBacklogBytesMax: 0,
      parseSuccessRecords: 0,
      parseFailedRecords: 0,
      readDurationMs: 0,
      processDurationMs: 0,
    });
  });

  it('keeps fixed scalar state regardless of observed record volume', () => {
    const accumulator = new InputRuntimeAccumulator();
    const stateKeys = Object.keys(accumulator).sort();

    for (let index = 0; index < 100_000; index++) {
      accumulator.observeCommittedBatch({
        bytes: 64,
        records: 1,
        parseSuccessRecords: 1,
        parseFailedRecords: 0,
        maxRecordBytes: 64,
      });
    }

    expect(Object.keys(accumulator).sort()).toEqual(stateKeys);
    expect(Object.values(accumulator).every(value => typeof value === 'number')).toBe(true);
    expect(accumulator.finish(1)).toMatchObject({
      rawInRecords: 100_000,
      rawInBytes: 6_400_000,
      rawInMaxRecordBytes: 64,
    });
  });
});
