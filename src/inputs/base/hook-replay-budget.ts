import { performance } from 'node:perf_hooks';

export const HOOK_HISTORY_RATE_ENV = 'LOONGSUITE_PILOT_HOOK_HISTORY_BYTES_PER_MINUTE';
export const HOOK_RECORD_LIMIT_ENV = 'LOONGSUITE_PILOT_HOOK_MAX_RECORD_BYTES';
export const DEFAULT_HOOK_HISTORY_BYTES_PER_MINUTE = 4 * 1024 * 1024;
export const HOOK_REPLAY_BURST_BYTES = 1024 * 1024;
export const HOOK_PROCESS_MAX_RECORDS = 256;
export const HOOK_PROCESS_BUDGET_MS = 50;
export const HOOK_MAX_RECORD_BYTES = 32 * 1024 * 1024;

export interface HookReplayOptions {
  bytesPerMinute?: number;
  maxRecordBytes?: number;
  /** Injectable monotonic clock for deterministic scheduling tests. */
  now?: () => number;
  /** Process CPU clock; excludes waiting for disk/git I/O from the work quota. */
  cpuNow?: () => number;
}

/** Background replay uses actual read bytes, including partial lines and
 * records crossing a burst. Debt delays the next read instead of skipping data.
 */
export class HookReplayBudget {
  readonly now: () => number;
  private readonly cpuNow: () => number;
  private readonly rate: number;
  private readonly maxRecordBytes: number;
  private credit: number;
  private updatedAt: number;

  constructor(options: HookReplayOptions = {}) {
    const raw = process.env[HOOK_HISTORY_RATE_ENV]?.trim();
    const configured = options.bytesPerMinute ?? (raw && /^(0|[1-9]\d*)$/.test(raw) ? Number(raw) : undefined);
    this.rate = configured !== undefined && Number.isSafeInteger(configured)
      && configured >= 0 && configured <= 1024 * 1024 * 1024
      ? configured : DEFAULT_HOOK_HISTORY_BYTES_PER_MINUTE;
    this.credit = this.rate > 0 ? Math.min(HOOK_REPLAY_BURST_BYTES, this.rate) : 0;
    const recordRaw = process.env[HOOK_RECORD_LIMIT_ENV]?.trim();
    const recordLimit = options.maxRecordBytes
      ?? (recordRaw && /^[1-9]\d*$/.test(recordRaw) ? Number(recordRaw) : undefined);
    this.maxRecordBytes = recordLimit !== undefined && Number.isSafeInteger(recordLimit)
      && recordLimit >= 1024 * 1024 && recordLimit <= 256 * 1024 * 1024 ? recordLimit : HOOK_MAX_RECORD_BYTES;
    this.now = options.now ?? (() => performance.now());
    this.cpuNow = options.cpuNow ?? (() => {
      const usage = process.cpuUsage();
      return (usage.user + usage.system) / 1000;
    });
    this.updatedAt = this.now();
  }

  available(): number {
    const now = this.now();
    this.credit = Math.min(HOOK_REPLAY_BURST_BYTES,
      this.credit + Math.max(0, now - this.updatedAt) * this.rate / 60000);
    this.updatedAt = now;
    return Math.max(0, Math.floor(this.credit));
  }

  charge(bytes: number): void { this.credit -= bytes; }

  work(): HookWorkBudget { return new HookWorkBudget(this.cpuNow, this.maxRecordBytes); }
}

export class HookWorkBudget {
  records = 0;
  private readonly deadline: number;
  constructor(private readonly now: () => number, readonly maxRecordBytes = HOOK_MAX_RECORD_BYTES) {
    this.deadline = now() + HOOK_PROCESS_BUDGET_MS;
  }
  canProcess(): boolean {
    // A slow first record must still make progress; JSON parsing is atomic.
    return this.records < HOOK_PROCESS_MAX_RECORDS
      && (this.records === 0 || this.now() < this.deadline);
  }
}
