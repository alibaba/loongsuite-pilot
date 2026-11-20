import type { FileHandle } from 'node:fs/promises';
import type { InputRuntimeAccumulator } from '../base/input-runtime-metrics.js';

/** Cooperative limits for all Doubao sources in one collector cycle. */
export class DoubaoWorkBudget {
  private readonly deadline: number;
  private processed = 0;
  private sinceYield = 0;
  remainingBytes: number;

  constructor(
    private readonly runtime: InputRuntimeAccumulator | null = null,
    limits: { bytes?: number; milliseconds?: number; records?: number } = {},
  ) {
    this.remainingBytes = limits.bytes ?? 8 * 1024 * 1024;
    this.deadline = performance.now() + (limits.milliseconds ?? 50);
    this.recordLimit = limits.records ?? 4096;
  }

  private readonly recordLimit: number;
  get exhausted(): boolean { return this.remainingBytes <= 0 || this.processed >= this.recordLimit || performance.now() >= this.deadline; }

  record(count = 1, work = count): void { this.processed += count; this.sinceYield += work; }

  parsed(bytes: number): void {
    this.record();
    this.runtime?.observeCommittedBatch({ bytes, records: 1, parseSuccessRecords: 1, parseFailedRecords: 0, maxRecordBytes: bytes });
  }

  async yieldIfNeeded(): Promise<void> {
    if (this.sinceYield < 256) return;
    this.sinceYield = 0;
    await new Promise<void>(resolve => setImmediate(resolve));
  }

  async read(handle: FileHandle, buffer: Buffer, length: number, position: number, finishing = false): Promise<number> {
    if (this.exhausted && !(finishing && length <= 64 && this.remainingBytes >= length)) throw new DoubaoWorkDeferred('cycle_budget');
    const requested = Math.min(length, this.remainingBytes), start = performance.now();
    const { bytesRead } = await handle.read(buffer, 0, requested, position);
    this.remainingBytes -= bytesRead;
    this.runtime?.observeRead(bytesRead, requested, performance.now() - start);
    return bytesRead;
  }
}

/** Defer unfinished telemetry work; it is never an empty native result. */
export class DoubaoWorkDeferred extends Error {
  constructor(readonly reason: string) { super(reason); }
}
