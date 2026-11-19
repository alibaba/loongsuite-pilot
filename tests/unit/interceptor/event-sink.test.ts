import { afterEach, describe, expect, it, vi } from 'vitest';
import { InterceptorEventSink } from '../../../src/interceptor/event-sink.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';

function entry(id: number): AgentActivityEntry {
  return { 'event.id': String(id), 'event.name': 'guardrail.evaluation', 'user.id': '', time_unix_nano: '1',
    'gen_ai.agent.type': 'qoder', 'gen_ai.session.id': 'session', 'gen_ai.provider.name': 'unknown' };
}
afterEach(() => vi.useRealTimers());

describe('bounded interceptor event sink', () => {
  it('starts one consumer at a time, caps admission, and joins all accepted events on close', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let active = 0;
    let peak = 0;
    const consume = vi.fn(async () => { active++; peak = Math.max(peak, active); await gate; active--; });
    const warn = vi.fn();
    const sink = new InterceptorEventSink({ evaluation: consume }, { capacity: 2, maxBytes: 10_000, warn });
    sink.enqueue([], Array.from({ length: 500 }, (_, i) => entry(i)));
    await Promise.resolve();
    expect(consume).toHaveBeenCalledOnce();
    expect(sink.stats).toMatchObject({ pending: 1, active: 1, completed: 0, dropped: 498 });
    let finished = false;
    const stopped = sink.close().then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    release();
    await stopped;
    expect(consume).toHaveBeenCalledTimes(2);
    expect(peak).toBe(1);
    expect(sink.stats).toMatchObject({ pending: 0, active: 0, completed: 2, dropped: 498 });
    expect(warn).toHaveBeenCalledWith('interceptor event sink admission dropped events', expect.objectContaining({ dropped: 498 }));
  });

  it('also bounds bytes so a small number of huge prompt events cannot inflate the queue', async () => {
    const consume = vi.fn();
    const warn = vi.fn();
    const sink = new InterceptorEventSink({ blockedPrompt: consume }, { capacity: 256, maxBytes: 64, warn });
    sink.enqueue([entry(1)], []);
    await sink.close();
    expect(consume).not.toHaveBeenCalled();
    expect(sink.stats).toMatchObject({ pending: 0, active: 0, dropped: 1 });
  });

  it('bounds shutdown for a hung consumer, aborts it, and never starts queued events afterwards', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const consume = vi.fn((_entry, abort: AbortSignal) => { signal = abort; return new Promise<void>(() => {}); });
    const warn = vi.fn();
    const sink = new InterceptorEventSink({ evaluation: consume }, { capacity: 2, drainTimeoutMs: 100, warn });
    sink.enqueue([], [entry(1), entry(2)]);
    await Promise.resolve();
    const stopped = sink.close();
    await vi.advanceTimersByTimeAsync(101);
    await stopped;
    expect(signal?.aborted).toBe(true);
    expect(consume).toHaveBeenCalledOnce();
    expect(sink.stats).toMatchObject({ pending: 0, active: 1, dropped: 1 });
    expect(warn).toHaveBeenCalledWith('interceptor event sink shutdown left unfinished events', expect.objectContaining({ unfinished: 2 }));
  });
});
