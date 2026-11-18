import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCronRecovery, cronRunEndMs, hasFinishedCronRun } from '../../../../assets/plugins/openclaw/cron-recovery.mjs';

describe('OpenClaw native cron recovery', () => {
  afterEach(() => vi.useRealTimers());
  const snapshot = { jobId: 'job-a', runAtMs: 100 };

  it('requires the exact native finished run and never infers completion of an active or unknown run', () => {
    const job = state => ({ id: 'job-a', state });
    expect(hasFinishedCronRun(job({ lastRunAtMs: 100, lastRunStatus: 'error' }), snapshot)).toBe(true);
    expect(hasFinishedCronRun(job({ runningAtMs: 200, lastRunAtMs: 100, lastRunStatus: 'ok' }), snapshot)).toBe(true);
    expect(hasFinishedCronRun(job({ runningAtMs: 100, lastRunAtMs: 100, lastRunStatus: 'ok' }), snapshot)).toBe(false);
    expect(hasFinishedCronRun(job({ lastRunAtMs: 99, lastRunStatus: 'ok' }), snapshot)).toBe(false);
    expect(hasFinishedCronRun(job({ lastRunAtMs: 100 }), snapshot)).toBe(false);
    expect(hasFinishedCronRun(undefined, snapshot)).toBe(false);
  });

  it('uses a valid native run duration without manufacturing missing or invalid times', () => {
    expect(cronRunEndMs(1_700_000_000_000, 123)).toBe(1_700_000_000_123);
    expect(cronRunEndMs(100, undefined)).toBeUndefined();
    expect(cronRunEndMs(100, -1)).toBeUndefined();
    expect(cronRunEndMs(Number.MAX_SAFE_INTEGER, 1)).toBeUndefined();
  });

  it('recovers only matching finished jobs and retains missing, active and failed writes for retry', async () => {
    const snapshots = [snapshot, { jobId: 'active', runAtMs: 200 }, { jobId: 'missing', runAtMs: 300 },
      { jobId: 'retry', runAtMs: 400 }];
    const contexts = { listBatch: vi.fn(async () => ({ items: snapshots, more: false })), closeScan: vi.fn() };
    const jobs = [
      { id: 'job-a', state: { lastRunAtMs: 100, lastRunStatus: 'ok' } },
      { id: 'active', state: { runningAtMs: 200 } },
      { id: 'retry', state: { lastRunAtMs: 400, lastRunStatus: 'error' } },
    ];
    const recovered = vi.fn(item => item.jobId !== 'retry');
    const list = vi.fn(async () => jobs);
    const recovery = createCronRecovery(contexts, vi.fn());
    recovery.configure(() => ({ list }), recovered);
    expect(await recovery.reconcile()).toBe(true);
    expect(list).toHaveBeenCalledWith({ includeDisabled: true });
    expect(recovered.mock.calls.map(([item]) => item.jobId)).toEqual(['job-a', 'retry']);
    recovery.stop();
  });

  it('does not emit a late result after Gateway stop', async () => {
    let release;
    const list = vi.fn(() => new Promise(resolve => { release = resolve; }));
    const contexts = { listBatch: vi.fn(async () => ({ items: [snapshot], more: false })), closeScan: vi.fn() };
    const recovered = vi.fn();
    const recovery = createCronRecovery(contexts, vi.fn());
    recovery.configure(() => ({ list }), recovered);
    const running = recovery.reconcile();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    recovery.stop();
    release([{ id: 'job-a', state: { lastRunAtMs: 100, lastRunStatus: 'ok' } }]);
    expect(await running).toBe(false);
    expect(recovered).not.toHaveBeenCalled();
    expect(contexts.closeScan).toHaveBeenCalledOnce();
  });

  it('polls again after native state or a terminal write is temporarily unavailable', async () => {
    vi.useFakeTimers();
    const contexts = { listBatch: vi.fn(async () => ({ items: [snapshot], more: false })), closeScan: vi.fn() };
    const list = vi.fn().mockRejectedValueOnce(new Error('temporary')).mockResolvedValue([
      { id: 'job-a', state: { lastRunAtMs: 100, lastRunStatus: 'ok' } },
    ]);
    const recovered = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    const recovery = createCronRecovery(contexts, vi.fn(), 50);
    recovery.configure(() => ({ list }), recovered);
    recovery.wake();
    await vi.advanceTimersByTimeAsync(150);
    expect(list).toHaveBeenCalledTimes(3);
    expect(recovered).toHaveBeenCalledTimes(2);
    recovery.stop();
  });
});
