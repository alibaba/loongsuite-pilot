import { describe, it, expect } from 'vitest';
import { boundedMessageFingerprint } from '../../../../assets/plugins/openclaw/legacy-utils.mjs';

describe('bounded legacy deduplication', () => {
  it('deduplicates complete small messages but distinguishes native identities', () => {
    const a = { responseId: 'a', timestamp: 100, content: [{ text: 'same' }] };
    expect(boundedMessageFingerprint(a)).toBe(boundedMessageFingerprint(structuredClone(a)));
    expect(boundedMessageFingerprint(a)).not.toBe(boundedMessageFingerprint({ ...a, responseId: 'b' }));
  });
  it('declines oversized/deep payloads without merging messages sharing a large prefix', () => {
    const prefix = 'x'.repeat(100_000);
    expect(boundedMessageFingerprint({ content: prefix + 'a' })).toBeNull();
    expect(boundedMessageFingerprint({ content: prefix + 'b' })).toBeNull();
    let deep = {};
    for (let i = 0; i < 30; i++) deep = { next: deep };
    expect(boundedMessageFingerprint(deep)).toBeNull();
    expect(boundedMessageFingerprint(Array(2000).fill(1))).toBeNull();
  });
  it('does not execute payload accessors or toJSON', () => {
    const payload = { get text() { throw new Error('must not execute'); } };
    expect(boundedMessageFingerprint(payload)).toBeNull();
    expect(boundedMessageFingerprint({ toJSON() { throw new Error('must not execute'); } })).not.toBeNull();
  });
  it('uses bounded native identity for oversized completed responses, not their shared prefix', () => {
    const a = { responseId: 'a', timestamp: 123, content: 'x'.repeat(100_000) };
    expect(boundedMessageFingerprint(a)).toMatch(/^native:/);
    expect(boundedMessageFingerprint(a)).toBe(boundedMessageFingerprint(structuredClone(a)));
    expect(boundedMessageFingerprint(a)).not.toBe(boundedMessageFingerprint({ ...a, responseId: 'b' }));
  });
});
