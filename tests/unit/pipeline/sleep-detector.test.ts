import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SleepDetector } from '../../../src/pipeline/sleep-detector.js';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

describe('SleepDetector', () => {
  let detector: SleepDetector;

  beforeEach(() => {
    vi.useFakeTimers();
    detector = new SleepDetector();
  });

  afterEach(() => {
    detector.stop();
    vi.useRealTimers();
  });

  it('emits wake event when time gap exceeds threshold', () => {
    const handler = vi.fn();
    detector.on('wake', handler);
    detector.start();

    // Normal tick at t=5s
    vi.advanceTimersByTime(5_000);
    expect(handler).not.toHaveBeenCalled();

    // Simulate sleep: jump system time forward by 60s without firing timers
    const now = Date.now();
    vi.setSystemTime(now + 60_000);
    // Fire the next interval callback — it will see the 60s gap
    vi.advanceTimersByTime(5_000);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].sleepDurationMs).toBeGreaterThanOrEqual(50_000);
  });

  it('does not emit wake during normal operation', () => {
    const handler = vi.fn();
    detector.on('wake', handler);
    detector.start();

    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(5_000);
    }

    expect(handler).not.toHaveBeenCalled();
  });

  it('stop clears timer and listeners', () => {
    const handler = vi.fn();
    detector.on('wake', handler);
    detector.start();
    detector.stop();

    vi.advanceTimersByTime(120_000);

    expect(handler).not.toHaveBeenCalled();
    expect(detector.listenerCount('wake')).toBe(0);
  });

  it('start is idempotent', () => {
    detector.start();
    detector.start();
    detector.stop();
  });
});
