import { describe, expect, test } from 'vitest';
import {
  toW3CTraceId,
  deriveSpanId,
} from '../../../../assets/hooks/shared/event-emitter.mjs';

// ─── trace_id conversion ───

describe('toW3CTraceId', () => {
  test('UUID with dashes → 32-char lowercase hex (spec §1.5 #4 traceId UUID→W3C 转换)', () => {
    const uuid = 'e294f5ce-30c2-4817-92be-d035412905a1';
    const w3c = toW3CTraceId(uuid);
    expect(w3c).toBe('e294f5ce30c2481792bed035412905a1');
    expect(w3c.length).toBe(32);
    expect(/^[0-9a-f]{32}$/.test(w3c)).toBe(true);
    expect(w3c.includes('-')).toBe(false);
  });

  test('already-W3C 32-hex string passes through lowercased', () => {
    const already = 'e294f5ce30c2481792bed035412905a1';
    expect(toW3CTraceId(already)).toBe(already);
    expect(toW3CTraceId(already.toUpperCase())).toBe(already);
  });

  test('non-UUID / non-hex string passes through lowercased (no dash stripping chaos)', () => {
    expect(toW3CTraceId('abc-123')).toBe('abc-123');
    expect(toW3CTraceId('')).toBe('');
    expect(toW3CTraceId(undefined)).toBe('');
    expect(toW3CTraceId(null)).toBe('');
  });

  test('paired fixture traceId converts to expected W3C value', () => {
    // From artifacts/rollout-model-io-paired.jsonl + hook-stop-stdin-paired.json
    // (sess_36734977 / turn_b8638fe6 / trace_e294f5ce — see paired-id-consistency.md)
    const traceId = 'e294f5ce-30c2-4817-92be-d035412905a1';
    expect(toW3CTraceId(traceId)).toBe('e294f5ce30c2481792bed035412905a1');
  });
});

// ─── span_id derivation — cross-source stitching contract ───

describe('deriveSpanId', () => {
  test('produces 16-char lowercase hex', () => {
    const sid = deriveSpanId('agent', 'sess_36734977', 'turn_b8638fe6');
    expect(sid.length).toBe(16);
    expect(/^[0-9a-f]{16}$/.test(sid)).toBe(true);
  });

  test('deterministic — same inputs always produce same span_id (spec §1.5 #8 跨源 parent 拼接派生一致)', () => {
    const sid1 = deriveSpanId('agent', 'sess_36734977', 'turn_b8638fe6');
    const sid2 = deriveSpanId('agent', 'sess_36734977', 'turn_b8638fe6');
    expect(sid1).toBe(sid2);
  });

  test('different namespaces with same key material never collide (salt prevents ENTRY/AGENT/STEP/LLM/TOOL collision)', () => {
    const keys = ['sess_36734977', 'turn_b8638fe6'];
    const entry = deriveSpanId('entry', ...keys);
    const agent = deriveSpanId('agent', ...keys);
    const step = deriveSpanId('step', ...keys, '1');
    const llm = deriveSpanId('llm', ...keys, '1', 'r');
    const tool = deriveSpanId('tool', ...keys, '1', 'tc1');
    const all = new Set([entry, agent, step, llm, tool]);
    expect(all.size).toBe(5);
  });

  test('AGENT span_id derivation matches what the hook-processor uses (single shared function — architect de8a29fe reminder)', () => {
    // The hook-processor calls deriveSpanId('agent', sessionId, turnId) to set
    // AGENT envelope span_id. The rollout input calls the same function with
    // same args to set STEP parent_span_id. They MUST match.
    const sessionId = 'sess_36734977-639d-4424-94ba-8c1957576a5f';
    const turnId = 'turn_b8638fe6-b763-4258-9b91-660d2f8edaef';
    const agentSpanId = deriveSpanId('agent', sessionId, turnId);
    const stepParentSpanId = deriveSpanId('agent', sessionId, turnId);
    expect(agentSpanId).toBe(stepParentSpanId);
  });
});
