import { describe, expect, it } from 'vitest';
import { enrichCliTurn } from '../../../../src/inputs/qoder-trace/token-enricher.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';
import type { InterceptTokenData } from '../../../../src/inputs/qoder-trace/intercept-token-reader.js';
import type { SegmentTokenData } from '../../../../src/inputs/qoder-trace/segment-token-reader.js';

// Fixtures model the documented real-data shapes from architect NEEDS_REVISION
// review (issue AGE-1730, comment a1656a71):
//   - History JSONL gen_ai.response.id: Anthropic message.id format ("resp_...")
//   - Segment request_id: UUID format (e.g. "c3be0573-f0d4-4347-b6a0-d9f8ec6d00ae")
//   - gen_ai.step.id: `${turn_id}:s${request_index}` (e.g. "turn-1:s1")
// The cases below intentionally mix the two ID formats to exercise the
// order-fallback path the fix introduces.

function makeResponse(overrides: Partial<AgentActivityEntry> = {}): AgentActivityEntry {
  return {
    'event.id': 'e-1',
    'event.name': 'llm.response',
    'gen_ai.session.id': 'sess-f287bf17',
    'gen_ai.turn.id': 'turn-1',
    'gen_ai.step.id': 'turn-1:s1',
    'gen_ai.agent.type': 'qoder-cli',
    time_unix_nano: '1780000000000000000',
    ...overrides,
  } as AgentActivityEntry;
}

function makeRequest(overrides: Partial<AgentActivityEntry> = {}): AgentActivityEntry {
  return {
    'event.id': 'e-0',
    'event.name': 'llm.request',
    'gen_ai.session.id': 'sess-f287bf17',
    'gen_ai.turn.id': 'turn-1',
    'gen_ai.step.id': 'turn-1:s1',
    'gen_ai.agent.type': 'qoder-cli',
    time_unix_nano: '1780000000000000000',
    'gen_ai.request.model': 'auto',
    ...overrides,
  } as AgentActivityEntry;
}

function makeSeg(overrides: Partial<SegmentTokenData> = {}): SegmentTokenData {
  return {
    requestId: 'c3be0573-f0d4-4347-b6a0-d9f8ec6d00ae',
    inputTokens: 5000,
    outputTokens: 200,
    cacheReadTokens: 3000,
    cacheCreationTokens: 0,
    requestStartTs: 1780000000000,
    responseEndTs: 1780000002000,
    toolFinishedTs: 0,
    stopReason: 'end_turn',
    model: 'claude-sonnet-4-5',
    ...overrides,
  };
}

function makeIntercept(overrides: Partial<InterceptTokenData> = {}): InterceptTokenData {
  return {
    id: 'resp_intercept_A',
    ts: 1780000002000,
    promptTokens: 1200,
    completionTokens: 80,
    cachedTokens: 900,
    reasoningTokens: 0,
    totalTokens: 1280,
    ...overrides,
  };
}

describe('token-enricher enrichCliTurn', () => {
  describe('Case 1: exact response.id match (regression)', () => {
    it('injects usage/timestamps/model when response.id === seg.requestId', () => {
      const entries: AgentActivityEntry[] = [
        makeRequest({ 'gen_ai.step.id': 'turn-1:s1' }),
        makeResponse({ 'gen_ai.response.id': 'c3be0573-f0d4-4347-b6a0-d9f8ec6d00ae' }),
      ];
      const segments: SegmentTokenData[] = [
        makeSeg({ requestId: 'c3be0573-f0d4-4347-b6a0-d9f8ec6d00ae' }),
      ];

      enrichCliTurn(entries, segments);

      const resp = entries[1];
      expect(resp['gen_ai.usage.input_tokens']).toBe(5000);
      expect(resp['gen_ai.usage.output_tokens']).toBe(200);
      expect(resp['gen_ai.response.model']).toBe('claude-sonnet-4-5');
      expect(resp.time_unix_nano).toBe(String(BigInt(1780000002000) * 1_000_000n));
      expect(entries[0].time_unix_nano).toBe(String(BigInt(1780000000000) * 1_000_000n));
      expect(entries[0]['gen_ai.request.model']).toBe('claude-sonnet-4-5');
    });
  });

  describe("Case 2: response.id mismatch (history resp_xxx vs segment UUID) — order fallback", () => {
    it('pairs segment i-th with step s(i+1) by order when response.id diverges', () => {
      // History gen_ai.response.id uses Anthropic message.id format ("resp_...")
      // while segment request_id is a UUID. Exact match misses on both steps.
      // Order fallback: seg[0] (sorted by responseEndTs asc) ↔ step s1, seg[1] ↔ step s2.
      const entries: AgentActivityEntry[] = [
        makeRequest({ 'gen_ai.step.id': 'turn-1:s1', time_unix_nano: '1780000000000000000' }),
        makeResponse({
          'gen_ai.response.id': 'resp_0bfdfd26719a749f016a9680cc7f6c8194a84682cf40d8499c',
          'gen_ai.step.id': 'turn-1:s1',
          time_unix_nano: '1780000000000000000',
        }),
        makeRequest({ 'gen_ai.step.id': 'turn-1:s2', time_unix_nano: '1780000010000000000' }),
        makeResponse({
          'gen_ai.response.id': 'resp_0bfdfd26719a749f016a9680e4182c8194ab162def90bfcd02',
          'gen_ai.step.id': 'turn-1:s2',
          time_unix_nano: '1780000010000000000',
        }),
      ];
      const segments: SegmentTokenData[] = [
        makeSeg({
          requestId: 'c3be0573-f0d4-4347-b6a0-d9f8ec6d00ae',
          requestStartTs: 1780000000000,
          responseEndTs: 1780000002000,
        }),
        makeSeg({
          requestId: 'af972b1e-61df-4b40-92a3-efa1521c8e8a',
          requestStartTs: 1780000010000,
          responseEndTs: 1780000012000,
        }),
      ];

      enrichCliTurn(entries, segments);

      // s1 response paired with seg[0]
      const s1Resp = entries[1];
      expect(s1Resp['gen_ai.response.model']).toBe('claude-sonnet-4-5');
      expect(s1Resp.time_unix_nano).toBe(String(BigInt(1780000002000) * 1_000_000n));
      expect(s1Resp['gen_ai.usage.input_tokens']).toBe(5000);
      // s1 request timestamp injected from segment.requestStartTs
      expect(entries[0].time_unix_nano).toBe(String(BigInt(1780000000000) * 1_000_000n));

      // s2 response paired with seg[1]
      const s2Resp = entries[3];
      expect(s2Resp.time_unix_nano).toBe(String(BigInt(1780000012000) * 1_000_000n));
      expect(s2Resp['gen_ai.usage.input_tokens']).toBe(5000);
      expect(entries[2].time_unix_nano).toBe(String(BigInt(1780000010000) * 1_000_000n));
    });

    it('leaves unmatched segments alone when there are no unclaimed step responses', () => {
      // One response, two segments, both with mismatched response.id. Only one
      // entry can be claimed by order fallback; the second segment is left
      // unmatched — no regression (entry stays at original values).
      const entries: AgentActivityEntry[] = [
        makeResponse({
          'gen_ai.response.id': 'resp_history_1',
          'gen_ai.step.id': 'turn-1:s1',
          time_unix_nano: '1780000000000000000',
        }),
      ];
      const segments: SegmentTokenData[] = [
        makeSeg({ requestId: 'seg-uuid-1', responseEndTs: 1780000001000, requestStartTs: 1780000000000 }),
        makeSeg({ requestId: 'seg-uuid-2', responseEndTs: 1780000002000, requestStartTs: 1780000001000 }),
      ];

      enrichCliTurn(entries, segments);

      // Single entry paired with seg[0] (lower responseEndTs)
      expect(entries[0]['gen_ai.usage.input_tokens']).toBe(5000);
      expect(entries[0].time_unix_nano).toBe(String(BigInt(1780000001000) * 1_000_000n));
    });
  });

  describe('Case 3: mixed exact + order fallback (exact match takes priority)', () => {
    it('claims entries for exact response.id matches before order fallback runs', () => {
      // s1 has matching response.id (exact match). s2 has mismatching
      // response.id (order fallback). Order fallback must skip the entry
      // claimed by exact match for s1, and pair s2's segment with the next
      // unclaimed step response.
      const entries: AgentActivityEntry[] = [
        makeRequest({ 'gen_ai.step.id': 'turn-1:s1' }),
        makeResponse({
          'gen_ai.response.id': 'c3be0573-f0d4-4347-b6a0-d9f8ec6d00ae', // matches seg[0].requestId
          'gen_ai.step.id': 'turn-1:s1',
        }),
        makeRequest({ 'gen_ai.step.id': 'turn-1:s2' }),
        makeResponse({
          'gen_ai.response.id': 'resp_anthropic_message_id', // mismatches seg[1].requestId
          'gen_ai.step.id': 'turn-1:s2',
        }),
      ];
      const segments: SegmentTokenData[] = [
        makeSeg({
          requestId: 'c3be0573-f0d4-4347-b6a0-d9f8ec6d00ae',
          requestStartTs: 1780000000000,
          responseEndTs: 1780000002000,
        }),
        makeSeg({
          requestId: 'af972b1e-61df-4b40-92a3-efa1521c8e8a',
          requestStartTs: 1780000010000,
          responseEndTs: 1780000012000,
        }),
      ];

      enrichCliTurn(entries, segments);

      // s1 paired by exact match
      expect(entries[1]['gen_ai.usage.input_tokens']).toBe(5000);
      expect(entries[1].time_unix_nano).toBe(String(BigInt(1780000002000) * 1_000_000n));
      // s2 paired by order fallback (skipped s1's claimed entry)
      expect(entries[3]['gen_ai.usage.input_tokens']).toBe(5000);
      expect(entries[3].time_unix_nano).toBe(String(BigInt(1780000012000) * 1_000_000n));
      expect(entries[2].time_unix_nano).toBe(String(BigInt(1780000010000) * 1_000_000n));
    });
  });

  describe('intercept overrides segment usage even when order fallback applied', () => {
    it('applies intercept usage by response.id after segment order fallback', () => {
      const entries: AgentActivityEntry[] = [
        makeResponse({
          'gen_ai.response.id': 'resp_intercept_A', // matches intercept id, mismatches seg.requestId
          'gen_ai.step.id': 'turn-1:s1',
        }),
      ];
      const segments: SegmentTokenData[] = [
        makeSeg({
          requestId: 'c3be0573-f0d4-4347-b6a0-d9f8ec6d00ae',
          inputTokens: 9999, // would be applied by segment, but intercept should win
          requestStartTs: 1780000000000,
          responseEndTs: 1780000002000,
        }),
      ];

      enrichCliTurn(entries, segments, undefined, [makeIntercept()]);

      // Intercept overrides segment usage
      expect(entries[0]['gen_ai.usage.input_tokens']).toBe(1200);
      expect(entries[0]['gen_ai.usage.output_tokens']).toBe(80);
      expect(entries[0]['gen_ai.usage.total_tokens']).toBe(1280);
      // But segment-derived timestamp sticks (segment is the unified clock source)
      expect(entries[0].time_unix_nano).toBe(String(BigInt(1780000002000) * 1_000_000n));
    });
  });
});
