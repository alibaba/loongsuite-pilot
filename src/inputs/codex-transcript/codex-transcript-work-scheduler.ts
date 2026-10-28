import { performance } from 'node:perf_hooks';
import { setImmediate as yieldImmediate } from 'node:timers/promises';
import type { InputRuntimeAccumulator } from '../base/input-runtime-metrics.js';

export interface CodexWorkLimits {
  cycleReadBytes: number;
  cycleReadCalls: number;
  workSliceMs: number;
  fileQuantumBytes: number;
  fileCycleReadBytes: number;
  maxReadChunkBytes: number;
  maxWorkSteps: number;
}

export const DEFAULT_CODEX_WORK_LIMITS: Readonly<CodexWorkLimits> = Object.freeze({
  cycleReadBytes: 32 * 1024 * 1024,
  cycleReadCalls: 128,
  workSliceMs: 100,
  fileQuantumBytes: 2 * 1024 * 1024,
  fileCycleReadBytes: 16 * 1024 * 1024,
  maxReadChunkBytes: 1024 * 1024,
  maxWorkSteps: 128,
});

type FileReadUsage = { consumed: number; reserved: number };

/** A reservation must be settled even after a failed syscall. */
export interface CodexReadReservation {
  requestedBytes: number;
  settle(bytesRead: number): void;
}

/** One Input cycle's shared I/O limits; no reader can borrow beyond this budget. */
export class CodexWorkBudget {
  readonly limits: Readonly<CodexWorkLimits>;
  readonly startedAtMs: number;
  private consumed = 0;
  private reserved = 0;
  private calls = 0;
  private workSteps = 0;
  private readonly files = new Map<string, FileReadUsage>();
  private readonly deferred = new Set<string>();
  private recordsSinceYield = 0;
  private lastYieldAtMs: number;
  /** Input 级容量准入；拒绝读取只表示延期，不改变完整行或恢复范围。 */
  allowBufferGrowth?: (filePath: string, bufferedBytes: number, requestedBytes: number) => boolean;

  constructor(
    options: Partial<CodexWorkLimits> = {},
    readonly runtime?: InputRuntimeAccumulator | null,
    readonly now: () => number = () => performance.now(),
  ) {
    const limits = { ...DEFAULT_CODEX_WORK_LIMITS, ...options };
    for (const [key, value] of Object.entries(limits)) {
      if (!Number.isFinite(value) || value < 0 || (key !== 'workSliceMs' && !Number.isSafeInteger(value))) {
        throw new RangeError(`invalid Codex work limit: ${key}`);
      }
    }
    this.limits = Object.freeze(limits);
    this.startedAtMs = this.now();
    this.lastYieldAtMs = this.startedAtMs;
    this.runtime?.enableCodexReadMetrics();
  }

  get readBytes(): number { return this.consumed; }
  get readCalls(): number { return this.calls; }
  get timeExpired(): boolean { return this.now() - this.startedAtMs >= this.limits.workSliceMs; }
  get canWork(): boolean {
    return !this.timeExpired && this.consumed + this.reserved < this.limits.cycleReadBytes
      && this.calls < this.limits.cycleReadCalls && this.workSteps < this.limits.maxWorkSteps;
  }

  finishWorkStep(): void { this.workSteps++; }

  fileReadBytes(filePath: string): number { return this.files.get(filePath)?.consumed ?? 0; }

  canReadFile(filePath: string): boolean {
    const usage = this.files.get(filePath);
    return this.canWork && (usage ? usage.consumed + usage.reserved : 0) < this.limits.fileCycleReadBytes;
  }

  fileSlice(filePath: string): CodexFileWorkSlice {
    return new CodexFileWorkSlice(this, filePath);
  }

  reserve(filePath: string, requested: number, quantumRemaining: number): CodexReadReservation | null {
    if (!Number.isSafeInteger(requested) || requested < 0) throw new RangeError('invalid read length');
    if (!Number.isSafeInteger(quantumRemaining) || quantumRemaining < 0) throw new RangeError('invalid read quantum');
    if (requested === 0 || !this.canReadFile(filePath)) return null;
    const usage = this.files.get(filePath) ?? { consumed: 0, reserved: 0 };
    const length = Math.min(
      requested, quantumRemaining, this.limits.maxReadChunkBytes,
      this.limits.cycleReadBytes - this.consumed - this.reserved,
      this.limits.fileCycleReadBytes - usage.consumed - usage.reserved,
    );
    if (length <= 0) return null;
    this.files.set(filePath, usage);
    this.reserved += length;
    usage.reserved += length;
    this.calls++;
    let settled = false;
    return {
      requestedBytes: length,
      settle: (bytesRead: number): void => {
        if (settled) throw new Error('Codex read reservation already settled');
        if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > length) {
          throw new RangeError('invalid returned read length');
        }
        settled = true;
        this.reserved -= length;
        usage.reserved -= length;
        this.consumed += bytesRead;
        usage.consumed += bytesRead;
      },
    };
  }

  noteDeferred(taskKey: string): void {
    if (this.deferred.has(taskKey)) return;
    this.deferred.add(taskKey);
    this.runtime?.observeCodexWork({ budgetDeferredTasks: 1 });
  }

  noteParse(startedAtMs: number): void {
    if (startedAtMs - this.startedAtMs < this.limits.workSliceMs && this.timeExpired) {
      this.runtime?.observeCodexWork({ parseSliceOverruns: 1 });
    }
  }

  /** Yield cooperatively even when parsing already-buffered records performs no reads. */
  async yieldIfNeeded(records = 1): Promise<void> {
    this.recordsSinceYield += records;
    if (this.recordsSinceYield < 256 && this.now() - this.lastYieldAtMs < 10) return;
    await yieldImmediate();
    this.recordsSinceYield = 0;
    this.lastYieldAtMs = this.now();
  }
}

/** Per-dispatch quantum layered over the shared cycle and per-file limits. */
export class CodexFileWorkSlice {
  private consumed = 0;
  private reserved = 0;

  constructor(readonly budget: CodexWorkBudget, readonly filePath: string) {}

  get timeExpired(): boolean { return this.budget.timeExpired; }
  get quantumExpired(): boolean { return this.consumed + this.reserved >= this.budget.limits.fileQuantumBytes; }
  get readBytes(): number { return this.consumed; }

  reserve(requested: number): CodexReadReservation | null {
    const reservation = this.budget.reserve(
      this.filePath, requested, this.budget.limits.fileQuantumBytes - this.consumed - this.reserved,
    );
    if (!reservation) return null;
    this.reserved += reservation.requestedBytes;
    return {
      requestedBytes: reservation.requestedBytes,
      settle: (bytesRead: number): void => {
        reservation.settle(bytesRead);
        this.reserved -= reservation.requestedBytes;
        this.consumed += bytesRead;
      },
    };
  }
}

export type CodexWorkPriority = 'hot' | 'cold';
export interface CodexWorkStepResult {
  status: 'complete' | 'deferred' | 'waiting';
  /** Buffered-only work may progress without issuing another source read. */
  progressed?: boolean;
}

export interface CodexWorkTask {
  key: string;
  filePath: string;
  priority: CodexWorkPriority;
  eligible?: () => boolean;
  step(slice: CodexFileWorkSlice): Promise<CodexWorkStepResult>;
}

type ScheduledTask = { task: CodexWorkTask; eligibleSince: number | null };

/** Persistent 3:1 queues. Exhaustion postpones work, never changes source semantics. */
export class CodexWorkScheduler {
  private readonly hot = new Map<string, ScheduledTask>();
  private readonly cold = new Map<string, ScheduledTask>();
  private slot = 0;

  constructor(private readonly now: () => number = () => performance.now()) {}

  get size(): number { return this.hot.size + this.cold.size; }

  enqueue(task: CodexWorkTask): boolean {
    const existing = this.hot.get(task.key) ?? this.cold.get(task.key);
    if (existing) {
      const previousPriority = existing.task.priority;
      existing.task = task;
      if (previousPriority !== task.priority) {
        this.delete(task.key);
        this.queue(task.priority).set(task.key, existing);
      }
      return false;
    }
    this.queue(task.priority).set(task.key, {
      task, eligibleSince: task.eligible?.() === false ? null : this.now(),
    });
    return true;
  }

  delete(key: string): void {
    this.hot.delete(key);
    this.cold.delete(key);
  }

  clear(): void {
    this.hot.clear();
    this.cold.clear();
    this.slot = 0;
  }

  async run(budget: CodexWorkBudget): Promise<number> {
    let steps = 0;
    const waiting = new Set<string>();
    const sourceWaiting = new Set<string>();
    while (budget.canWork && steps < budget.limits.maxWorkSteps) {
      const preferred: CodexWorkPriority = this.slot === 3 ? 'cold' : 'hot';
      const selected = this.select(preferred, waiting, budget)
        ?? this.select(preferred === 'hot' ? 'cold' : 'hot', waiting, budget);
      if (!selected) break;
      const { task } = selected;
      this.slot = (this.slot + 1) % 4;
      budget.runtime?.observeCodexWork({ eligibleWaitMsMax: Math.max(0, this.now() - selected.eligibleSince!) });
      selected.eligibleSince = this.now();
      // Requeue before awaiting so thrown errors cannot discard retained source ranges.
      const queue = this.queue(task.priority);
      queue.delete(task.key);
      queue.set(task.key, selected);
      const slice = budget.fileSlice(task.filePath);
      let result: CodexWorkStepResult;
      try { result = await task.step(slice); }
      finally { budget.finishWorkStep(); }
      steps++;
      if (result.status === 'complete') this.delete(task.key);
      else {
        if (result.status === 'waiting') sourceWaiting.add(task.key);
        if (result.status === 'waiting' || (!result.progressed && slice.readBytes === 0)) waiting.add(task.key);
      }
      await budget.yieldIfNeeded(0);
    }
    for (const value of [...this.hot.values(), ...this.cold.values()]) {
      const { task } = value;
      if (task.eligible?.() === false || sourceWaiting.has(task.key)) continue;
      value.eligibleSince ??= this.now();
      budget.runtime?.observeCodexWork({ eligibleWaitMsMax: Math.max(0, this.now() - value.eligibleSince) });
      budget.noteDeferred(task.key);
    }
    return steps;
  }

  private queue(priority: CodexWorkPriority): Map<string, ScheduledTask> {
    return priority === 'hot' ? this.hot : this.cold;
  }

  private select(priority: CodexWorkPriority, waiting: Set<string>, budget: CodexWorkBudget): ScheduledTask | null {
    const queue = this.queue(priority);
    for (const [key, value] of queue) {
      if (value.task.eligible?.() === false) {
        value.eligibleSince = null;
        continue;
      }
      value.eligibleSince ??= this.now();
      if (waiting.has(key)) continue;
      if (!budget.canReadFile(value.task.filePath)) {
        budget.noteDeferred(key);
        continue;
      }
      return value;
    }
    return null;
  }
}
