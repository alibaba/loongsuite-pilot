import { describe, expect, it } from 'vitest';
import { InputRuntimeAccumulator } from '../../../../src/inputs/base/input-runtime-metrics.js';
import {
  CodexWorkBudget, CodexWorkScheduler, DEFAULT_CODEX_WORK_LIMITS,
  type CodexWorkTask,
} from '../../../../src/inputs/codex-transcript/codex-transcript-work-scheduler.js';

const budget = (overrides: Parameters<typeof makeBudget>[0] = {}) => makeBudget(overrides);
function makeBudget(overrides: ConstructorParameters<typeof CodexWorkBudget>[0] = {}): CodexWorkBudget {
  return new CodexWorkBudget(overrides, null, () => 0);
}

function consume(work: CodexWorkBudget, path: string, requested: number, returned?: number): number {
  const lease = work.fileSlice(path).reserve(requested);
  if (!lease) return 0;
  const bytes = returned ?? lease.requestedBytes;
  lease.settle(bytes);
  return bytes;
}

describe('CodexWorkBudget', () => {
  it('reserves across readers before charging actual bytes and returns unused capacity', () => {
    const work = budget({ cycleReadBytes: 10, fileQuantumBytes: 10, maxReadChunkBytes: 10 });
    const a = work.fileSlice('a').reserve(8)!;
    const b = work.fileSlice('b').reserve(8)!;
    expect(a.requestedBytes).toBe(8);
    expect(b.requestedBytes).toBe(2);
    expect(work.fileSlice('c').reserve(1)).toBeNull();
    a.settle(3);
    b.settle(2);
    expect(consume(work, 'c', 10)).toBe(5);
    expect(work.readBytes).toBe(10);
    expect(work.readCalls).toBe(3);
    expect(() => a.settle(0)).toThrow('already settled');
  });

  it('enforces per-file, per-dispatch and global call limits including zero-byte reads', () => {
    const work = budget({ cycleReadBytes: 100, cycleReadCalls: 4, fileCycleReadBytes: 5, fileQuantumBytes: 3 });
    const a = work.fileSlice('a');
    const lease = a.reserve(100)!;
    expect(lease.requestedBytes).toBe(3);
    lease.settle(3);
    expect(a.reserve(100)).toBeNull();
    expect(consume(work, 'a', 100)).toBe(2);
    expect(work.canReadFile('a')).toBe(false);
    expect(consume(work, 'b', 100, 0)).toBe(0);
    expect(consume(work, 'b', 100, 0)).toBe(0);
    expect(work.readCalls).toBe(4);
    expect(work.fileSlice('c').reserve(1)).toBeNull();
  });

  it('stops new reads after a soft deadline and reports each postponed task once', () => {
    let now = 0;
    const runtime = new InputRuntimeAccumulator();
    const work = new CodexWorkBudget({ workSliceMs: 10 }, runtime, () => now);
    const lease = work.fileSlice('a').reserve(1)!;
    now = 11;
    lease.settle(1);
    expect(work.timeExpired).toBe(true);
    expect(work.fileSlice('b').reserve(1)).toBeNull();
    work.noteDeferred('a');
    work.noteDeferred('a');
    work.noteDeferred('b');
    work.noteParse(2);
    expect(runtime.finish(11).codexRead).toMatchObject({ budgetDeferredTasks: 2, parseSliceOverruns: 1 });
  });

  it('rejects unsafe or inverted limits and caps individual syscalls', () => {
    expect(() => budget({ cycleReadBytes: Number.NaN })).toThrow(RangeError);
    expect(() => budget({ cycleReadCalls: 1.5 })).toThrow(RangeError);
    expect(() => budget({ workSliceMs: -1 })).toThrow(RangeError);
    const work = budget();
    const lease = work.fileSlice('a').reserve(20 * 1024 * 1024)!;
    expect(lease.requestedBytes).toBe(DEFAULT_CODEX_WORK_LIMITS.maxReadChunkBytes);
    expect(() => lease.settle(lease.requestedBytes + 1)).toThrow(RangeError);
    lease.settle(0);
    expect(() => work.fileSlice('a').reserve(-1)).toThrow(RangeError);
  });
});

describe('CodexWorkScheduler', () => {
  it('rotates hot and cold tasks at 3:1 across cycle boundaries', async () => {
    const scheduler = new CodexWorkScheduler(() => 0);
    const seen: string[] = [];
    for (const [key, priority] of [['h1', 'hot'], ['h2', 'hot'], ['h3', 'hot'], ['c1', 'cold']] as const) {
      scheduler.enqueue({
        key, filePath: key, priority,
        async step(slice) {
          const lease = slice.reserve(1)!;
          lease.settle(1);
          seen.push(key);
          return { status: 'deferred', progressed: true };
        },
      });
    }
    for (let cycle = 0; cycle < 8; cycle++) {
      await scheduler.run(budget({ cycleReadBytes: 1, maxReadChunkBytes: 1 }));
    }
    expect(seen).toEqual(['h1', 'h2', 'h3', 'c1', 'h1', 'h2', 'h3', 'c1']);
    expect(scheduler.size).toBe(4);
  });

  it('does not count waiting for dependencies as an eligible read attempt', async () => {
    let eligible = false;
    let steps = 0;
    const runtime = new InputRuntimeAccumulator();
    const scheduler = new CodexWorkScheduler(() => 0);
    scheduler.enqueue({
      key: 'pending', filePath: 'pending', priority: 'hot', eligible: () => eligible,
      async step() { steps++; return { status: 'complete' }; },
    });
    await scheduler.run(new CodexWorkBudget({}, runtime, () => 0));
    expect(steps).toBe(0);
    expect(runtime.finish(0).codexRead!.budgetDeferredTasks).toBe(0);
    eligible = true;
    await scheduler.run(budget());
    expect(steps).toBe(1);
    expect(scheduler.size).toBe(0);
  });

  it('retains failed work and deduplicates repeated wakeups', async () => {
    const scheduler = new CodexWorkScheduler(() => 0);
    let fail = true;
    const task: CodexWorkTask = {
      key: 'retained', filePath: 'a', priority: 'cold',
      async step() {
        if (fail) throw new Error('read failure');
        return { status: 'complete' };
      },
    };
    expect(scheduler.enqueue(task)).toBe(true);
    expect(scheduler.enqueue(task)).toBe(false);
    await expect(scheduler.run(budget())).rejects.toThrow('read failure');
    expect(scheduler.size).toBe(1);
    fail = false;
    await scheduler.run(budget());
    expect(scheduler.size).toBe(0);
  });

  it('bounds a joint first-index and pending-recovery burst without starving small work', async () => {
    const scheduler = new CodexWorkScheduler(() => 0);
    const visits = new Map<string, number>();
    for (let index = 0; index < 64; index++) {
      const key = `file-${index}`;
      scheduler.enqueue({
        key, filePath: key, priority: index % 2 ? 'cold' : 'hot',
        async step(slice) {
          let read = 0;
          while (true) {
            const lease = slice.reserve(16 * 1024 * 1024);
            if (!lease) break;
            lease.settle(lease.requestedBytes);
            read += lease.requestedBytes;
          }
          visits.set(key, (visits.get(key) ?? 0) + 1);
          return { status: 'deferred', progressed: read > 0 };
        },
      });
    }
    for (let cycle = 0; cycle < 16; cycle++) {
      const work = budget();
      await scheduler.run(work);
      expect(work.readBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
      expect(work.readCalls).toBeLessThanOrEqual(128);
      for (let index = 0; index < 64; index++) expect(work.fileReadBytes(`file-${index}`)).toBeLessThanOrEqual(16 * 1024 * 1024);
    }
    expect(visits.size).toBe(64);
    expect([...visits.values()].every(count => count > 0)).toBe(true);
  });

  it('shares the work-step cap across schedulers, including rejected steps', async () => {
    const work = budget({ maxWorkSteps: 3 });
    const first = new CodexWorkScheduler(() => 0);
    const second = new CodexWorkScheduler(() => 0);
    first.enqueue({ key: 'failed', filePath: 'a', priority: 'hot', async step() { throw new Error('failed'); } });
    await expect(first.run(work)).rejects.toThrow('failed');
    let calls = 0;
    second.enqueue({ key: 'continuation', filePath: 'b', priority: 'hot', async step() {
      calls++; return { status: 'deferred', progressed: true };
    } });
    expect(await second.run(work)).toBe(2);
    expect(calls).toBe(2);
    expect(work.canWork).toBe(false);
    expect(first.size).toBe(1);
  });

  it('refreshes retained task closures and transfers a changed priority without duplicating work', async () => {
    const scheduler = new CodexWorkScheduler(() => 0);
    const seen: string[] = [];
    scheduler.enqueue({ key: 'a', filePath: 'a', priority: 'cold', async step() { throw new Error('stale closure'); } });
    scheduler.enqueue({ key: 'b', filePath: 'b', priority: 'hot', async step() { seen.push('b'); return { status: 'complete' }; } });
    expect(scheduler.enqueue({ key: 'a', filePath: 'a', priority: 'hot', async step() {
      seen.push('a'); return { status: 'complete' };
    } })).toBe(false);
    await scheduler.run(budget());
    expect(seen).toEqual(['b', 'a']);
    expect(scheduler.size).toBe(0);
  });

  it('dispatches every eligible file within four times the file count across repeated enqueue cycles', async () => {
    const scheduler = new CodexWorkScheduler(() => 0);
    const visits = new Map<string, number>();
    for (let cycle = 0; cycle < 4 * 32; cycle++) {
      for (let index = 0; index < 32; index++) {
        const key = `file-${index}`;
        scheduler.enqueue({ key, filePath: key, priority: index < 16 ? 'hot' : 'cold', async step(slice) {
          const lease = slice.reserve(1)!; lease.settle(1);
          if (!visits.has(key)) visits.set(key, cycle);
          return { status: 'deferred', progressed: true };
        } });
      }
      await scheduler.run(budget({ cycleReadBytes: 1 }));
    }
    expect(visits.size).toBe(32);
    expect(Math.max(...visits.values())).toBeLessThan(4 * 32);
  });

  it('limits buffered-only steps instead of busy-looping without I/O', async () => {
    const scheduler = new CodexWorkScheduler(() => 0);
    let steps = 0;
    scheduler.enqueue({ key: 'buffered', filePath: 'a', priority: 'hot', async step() {
      steps++;
      return { status: 'deferred', progressed: true };
    } });
    await scheduler.run(budget({ maxWorkSteps: 4 }));
    expect(steps).toBe(4);
    expect(scheduler.size).toBe(1);
  });
});
