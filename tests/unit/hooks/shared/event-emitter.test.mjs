import { describe, expect, it } from 'vitest';
import {
  INITIAL_HASH,
  hashStep,
  computeHash,
  shouldLogFullMessages,
  generateTraceId,
  generateSpanId,
} from '../../../../assets/hooks/shared/event-emitter.mjs';

describe('event-emitter chain hash', () => {
  it('INITIAL_HASH is 32 hex chars', () => {
    expect(INITIAL_HASH).toMatch(/^[0-9a-f]{32}$/);
  });

  it('hashStep is deterministic', () => {
    const h1 = hashStep(INITIAL_HASH, { role: 'user', content: 'hi' });
    const h2 = hashStep(INITIAL_HASH, { role: 'user', content: 'hi' });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{32}$/);
  });

  it('hashStep changes when message changes', () => {
    const h1 = hashStep(INITIAL_HASH, { role: 'user', content: 'hi' });
    const h2 = hashStep(INITIAL_HASH, { role: 'user', content: 'bye' });
    expect(h1).not.toBe(h2);
  });

  it('computeHash matches step-by-step accumulation', () => {
    const msgs = [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }];
    const expected = hashStep(hashStep(INITIAL_HASH, msgs[0]), msgs[1]);
    expect(computeHash(INITIAL_HASH, msgs)).toBe(expected);
  });

  it('shouldLogFullMessages true when chain is broken', () => {
    const delta = [{ role: 'user', content: 'x' }];
    // 假设 prev != initial,且 currentFullHash 不是从 prev + delta 算来 → 链断
    expect(shouldLogFullMessages(INITIAL_HASH, delta, 'fakehash')).toBe(true);
  });

  it('shouldLogFullMessages false when chain is consistent', () => {
    const delta = [{ role: 'user', content: 'x' }];
    const expected = computeHash(INITIAL_HASH, delta);
    expect(shouldLogFullMessages(INITIAL_HASH, delta, expected)).toBe(false);
  });
});

describe('event-emitter trace/span id', () => {
  it('generateTraceId returns 32 hex chars', () => {
    const t = generateTraceId();
    expect(t).toMatch(/^[0-9a-f]{32}$/);
  });

  it('generateSpanId returns 16 hex chars', () => {
    const s = generateSpanId();
    expect(s).toMatch(/^[0-9a-f]{16}$/);
  });

  it('successive calls return different ids', () => {
    expect(generateTraceId()).not.toBe(generateTraceId());
    expect(generateSpanId()).not.toBe(generateSpanId());
  });
});
