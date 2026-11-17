import type { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagedRegexRunner, ManagedRegexTimeoutError } from '../../../src/interceptor/managed/regex-runner.js';

const { terminationWarning } = vi.hoisted(() => ({ terminationWarning: vi.fn() }));
vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ warn: terminationWarning }),
}));

const runners: ManagedRegexRunner[] = [];
const matchingWorker = (runner: ManagedRegexRunner) => (runner as unknown as { worker: Worker | null }).worker;
function runner(timeoutMs = 1_000): ManagedRegexRunner {
  const instance = new ManagedRegexRunner(timeoutMs);
  runners.push(instance);
  return instance;
}
afterEach(() => {
  for (const instance of runners.splice(0)) instance.stop();
  terminationWarning.mockClear();
});

describe('managed regex matching thread', () => {
  it('reuses one thread for normal, invalid and subsequent successful matches', async () => {
    const instance = runner();
    await expect(instance.test('hello', 'hello')).resolves.toBe(true);
    const worker = matchingWorker(instance)!;
    expect(worker.threadId).toBeGreaterThan(0);
    await expect(instance.test('hello', 'goodbye')).resolves.toBe(false);
    await expect(instance.test('[', 'x')).rejects.toThrow();
    await expect(instance.test('next', 'next')).resolves.toBe(true);
    expect(matchingWorker(instance)).toBe(worker);
  });

  it('terminates catastrophic matches and exits each old thread before reusing a replacement', async () => {
    const instance = runner();
    for (let index = 0; index < 3; index += 1) {
      const slow = instance.test('(a+)+$', `${'a'.repeat(32)}!`, 150);
      const rejected = expect(slow).rejects.toBeInstanceOf(ManagedRegexTimeoutError);
      await vi.waitFor(() => expect(matchingWorker(instance)).not.toBeNull());
      const oldWorker = matchingWorker(instance)!;
      await rejected;
      await expect(instance.test('ok', 'ok')).resolves.toBe(true);
      expect(oldWorker.threadId).toBe(-1);
      expect(matchingWorker(instance)).not.toBe(oldWorker);
    }
  });

  it('rejects a queued match whose deadline elapsed during a slow match', async () => {
    const instance = runner();
    const slow = expect(instance.test('(a+)+$', `${'a'.repeat(32)}!`, 150))
      .rejects.toBeInstanceOf(ManagedRegexTimeoutError);
    await expect(instance.test('abc', 'abc', 1)).rejects.toBeInstanceOf(ManagedRegexTimeoutError);
    await slow;
    await expect(instance.test('abc', 'abc')).resolves.toBe(true);
  });

  it('rejects an active match immediately on unexpected thread exit and recovers queued work', async () => {
    const instance = runner();
    await expect(instance.test('warm', 'warm')).resolves.toBe(true);
    const worker = matchingWorker(instance)!;
    const slow = instance.test('(a+)+$', `${'a'.repeat(32)}!`, 5_000);
    const failed = expect(slow).rejects.toThrow('worker exited');
    await new Promise(resolve => setTimeout(resolve, 40));
    const queued = instance.test('recovered', 'recovered');
    await worker.terminate();
    await failed;
    await expect(queued).resolves.toBe(true);
  });

  it('stops a match waiting for the previous thread to finish terminating', async () => {
    const instance = runner();
    await instance.test('warm', 'warm');
    const worker = matchingWorker(instance)!;
    const terminate = worker.terminate.bind(worker);
    let finishRetirement!: () => void;
    const retirement = new Promise<void>(resolve => { finishRetirement = resolve; });
    vi.spyOn(worker, 'terminate').mockImplementation(async () => {
      const code = await terminate();
      await retirement;
      return code;
    });
    await expect(instance.test('(a+)+$', `${'a'.repeat(32)}!`, 100))
      .rejects.toBeInstanceOf(ManagedRegexTimeoutError);
    const waiting = instance.test('waiting', 'waiting', 5_000);
    const failed = expect(waiting).rejects.toThrow('stopped');
    await new Promise(resolve => setTimeout(resolve, 0));
    instance.stop();
    await failed;
    finishRetirement();
    expect(matchingWorker(instance)).toBeNull();
  });

  it('stops active work, terminates the matching thread and refuses subsequent matches', async () => {
    const instance = runner();
    await instance.test('warm', 'warm');
    const worker = matchingWorker(instance)!;
    const slow = instance.test('(a+)+$', `${'a'.repeat(32)}!`, 5_000);
    const failed = expect(slow).rejects.toThrow('stopped');
    await new Promise(resolve => setTimeout(resolve, 40));
    instance.stop();
    await failed;
    await vi.waitFor(() => expect(worker.threadId).toBe(-1));
    expect(matchingWorker(instance)).toBeNull();
    await expect(instance.test('a', 'a')).rejects.toBeInstanceOf(ManagedRegexTimeoutError);
  });

  it('reports a failed termination once and refuses to start an overlapping matching thread', async () => {
    const instance = runner();
    await instance.test('warm', 'warm');
    const worker = matchingWorker(instance)!;
    const terminate = worker.terminate.bind(worker);
    const failure = new Error('termination denied');
    const terminateSpy = vi.spyOn(worker, 'terminate').mockRejectedValueOnce(failure);
    try {
      await expect(instance.test('(a+)+$', `${'a'.repeat(32)}!`, 100))
        .rejects.toBeInstanceOf(ManagedRegexTimeoutError);
      await expect(instance.test('next', 'next')).rejects.toThrow('termination denied');
      await expect(instance.test('again', 'again')).rejects.toThrow('termination denied');
      expect(terminateSpy).toHaveBeenCalledOnce();
      expect(matchingWorker(instance)).toBeNull();
      expect(terminationWarning).toHaveBeenCalledOnce();
      expect(terminationWarning).toHaveBeenCalledWith(
        'managed regex worker termination failed; matching will fail open until interceptor restart',
        { error: String(failure) },
      );
    } finally {
      terminateSpy.mockRestore();
      await terminate();
    }
  });
});
