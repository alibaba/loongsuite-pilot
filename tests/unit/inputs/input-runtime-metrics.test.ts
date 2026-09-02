import { describe, expect, it } from 'vitest';
import { InputRuntimeAccumulator } from '../../../src/inputs/base/input-runtime-metrics.js';

describe('InputRuntimeAccumulator', () => {
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
