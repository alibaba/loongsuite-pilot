import type { Worker } from 'node:worker_threads';
import { createContext, runInContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagedRegexRunner, ManagedRegexCancelledError, ManagedRegexTimeoutError, REGEX_WORKER_SOURCE,
  REGEX_CACHE_MAX_ENTRIES, REGEX_CACHE_MAX_SOURCE_CHARS } from '../../../src/interceptor/managed/regex-runner.js';

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
  it('bounds the Worker cache by entries and source characters, reuses sources, and leaves oversized sources uncached', () => {
    let dispatch!: (job: unknown) => void;
    const replies: { matched: boolean }[] = [];
    const compile = vi.fn(function (source: string) { return new RegExp(source); });
    const context = createContext({ RegExp: compile, performance,
      require: () => ({ parentPort: { on: (_event: string, listener: typeof dispatch) => { dispatch = listener; },
        postMessage: (reply: { matched: boolean }) => replies.push(reply) } }) });
    runInContext(REGEX_WORKER_SOURCE, context);
    let id = 0;
    const match = (pattern: string, text = pattern) => { dispatch({ id: ++id, pattern, text }); return replies.at(-1)!.matched; };
    expect(match('first')).toBe(true);
    expect(match('first', 'miss')).toBe(false);
    expect(compile).toHaveBeenCalledTimes(1);
    expect(match('replacement', 'first')).toBe(false);
    expect(match('replacement')).toBe(true);
    for (let index = 0; index < REGEX_CACHE_MAX_ENTRIES; index++) match(`item-${index}`);
    expect(runInContext('cache.size', context)).toBe(REGEX_CACHE_MAX_ENTRIES);
    const count = compile.mock.calls.length;
    match('first');
    expect(compile).toHaveBeenCalledTimes(count + 1);
    // Empty alternatives keep native compilation cheap while exercising source budgets.
    for (let index = 0; index < 4; index++) match('|'.repeat(REGEX_CACHE_MAX_SOURCE_CHARS / 3) + index, '');
    expect(runInContext('sourceChars', context)).toBeLessThanOrEqual(REGEX_CACHE_MAX_SOURCE_CHARS);
    expect(runInContext('cache.size', context)).toBeLessThan(REGEX_CACHE_MAX_ENTRIES);
    const oversized = '|'.repeat(REGEX_CACHE_MAX_SOURCE_CHARS + 1);
    const before = runInContext('[cache.size, sourceChars]', context);
    match(oversized, '');
    match(oversized, '');
    expect(runInContext('[cache.size, sourceChars]', context)).toEqual(before);
    expect(compile.mock.calls.filter(([source]) => source === oversized)).toHaveLength(2);
  });

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

  it('returns execution timing measured inside the matching worker', async () => {
    const onExecuted = vi.fn();
    await expect(runner().test('hello', 'hello', 1_000, onExecuted)).resolves.toBe(true);
    expect(onExecuted).toHaveBeenCalledWith(expect.any(Number));
    expect(onExecuted.mock.calls[0][0]).toBeGreaterThanOrEqual(0);
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

  it('times out a whole structured plan as one job and recovers for the next plan', async () => {
    const instance = runner();
    const text = `${'a'.repeat(32)}!`;
    const plan = { kind: 'substring' as const, steps: [
      { kind: 'regex' as const, source: 'absent' },
      { kind: 'regex' as const, source: '(a+)+$' },
      { kind: 'literal' as const, text },
    ] };
    await expect(instance.test(plan, text, 150)).rejects.toBeInstanceOf(ManagedRegexTimeoutError);
    await expect(instance.test({ kind: 'substring', steps: [{ kind: 'literal', text }] }, text)).resolves.toBe(true);
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
    const failed = expect(waiting).rejects.toBeInstanceOf(ManagedRegexCancelledError);
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
    const failed = expect(slow).rejects.toBeInstanceOf(ManagedRegexCancelledError);
    const queued = expect(instance.test('queued', 'queued', 5_000)).rejects.toBeInstanceOf(ManagedRegexCancelledError);
    await new Promise(resolve => setTimeout(resolve, 40));
    instance.stop();
    await failed;
    await queued;
    await vi.waitFor(() => expect(worker.threadId).toBe(-1));
    expect(matchingWorker(instance)).toBeNull();
    await expect(instance.test('a', 'a')).rejects.toBeInstanceOf(ManagedRegexCancelledError);
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
