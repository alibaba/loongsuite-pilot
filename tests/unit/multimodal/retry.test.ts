import { describe, expect, it, vi } from 'vitest';
import { retryDelayMs, withRetries } from '../../../src/multimodal/uploader/retry.js';

describe('multimodal upload retry', () => {
  it('retryDelayMs stays within jitter bounds', () => {
    const policy = { maxAttempts: 3, baseDelayMs: 100 };
    for (let i = 0; i < 20; i++) {
      const delay = retryDelayMs(policy, 1);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(100);
    }
  });

  it('returns success on first ok attempt', async () => {
    const run = vi.fn(async () => ({ ok: true as const, value: 42 }));
    const result = await withRetries({ maxAttempts: 3, baseDelayMs: 0 }, run);
    expect(result).toEqual({ ok: true, value: 42 });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('stops immediately on non-retryable failure', async () => {
    const run = vi.fn(async () => ({
      ok: false as const,
      retryable: false,
      error: 'forbidden',
      statusCode: 403,
    }));
    const result = await withRetries({ maxAttempts: 3, baseDelayMs: 0 }, run);
    expect(result).toEqual({ ok: false, error: 'forbidden', statusCode: 403 });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('retries retryable failures until maxAttempts', async () => {
    const run = vi.fn(async () => ({
      ok: false as const,
      retryable: true,
      error: 'busy',
      statusCode: 503,
    }));
    const result = await withRetries({ maxAttempts: 3, baseDelayMs: 0 }, run);
    expect(result).toEqual({ ok: false, error: 'busy', statusCode: 503 });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('returns value after a later successful retry', async () => {
    let attempt = 0;
    const run = vi.fn(async () => {
      attempt += 1;
      if (attempt < 2) {
        return { ok: false as const, retryable: true, error: 'tmp', statusCode: 500 };
      }
      return { ok: true as const, value: 'ok' };
    });
    const result = await withRetries({ maxAttempts: 3, baseDelayMs: 0 }, run);
    expect(result).toEqual({ ok: true, value: 'ok' });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('stops without another attempt after abort', async () => {
    const abort = new AbortController();
    const run = vi.fn(async () => {
      abort.abort();
      return { ok: false as const, retryable: true, error: 'busy', statusCode: 503 };
    });
    const result = await withRetries({ maxAttempts: 3, baseDelayMs: 20 }, run, {
      signal: abort.signal,
    });
    expect(result).toEqual({ ok: false, error: 'aborted' });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
