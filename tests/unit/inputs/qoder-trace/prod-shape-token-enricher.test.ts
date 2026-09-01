import { describe, expect, it } from 'vitest';
import { enrichCliTurn } from '../../../../src/inputs/qoder-trace/token-enricher.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';
import type { SegmentTokenData } from '../../../../src/inputs/qoder-trace/segment-token-reader.js';

// Reproduces tester Round 6 E2E evidence (comment bdfe6f36):
//   - OTLP gen_ai.session.id = 303593aa-... (the qoder-cli session ID)
//   - OTLP gen_ai.turn.id   = 1df498c6-... (per-turn, hook-derived)
//   - OTLP gen_ai.step.id   = `${turn.id}:s${i+1}` (1-indexed)
//   - OTLP gen_ai.response.id = resp_xxx (Anthropic message.id format)
//   - Segment turn_id       = 303593aa-... (T1; NOTE: ≠ OTLP turn.id)
//   - Segment request_id    = UUID (e.g. c3be0573-...)
// Tester evidence: T1 LLM #1 OTLP startUnixNano matches seg.completed (11ms diff),
// NOT seg.started (6413ms diff) → duration = 0. Root cause: Pass 2 step.id filter
// uses seg.turnId prefix, but OTLP step.id uses OTLP turn.id prefix — mismatch
// breaks all pairing, llm.request.time_unix_nano stays at hook processor's
// `group[0].timestamp` fallback (≈ completed time).
// Fix: Pass 2 filters stepToResponses by OTLP turn.id (from entries), not seg.turnId.
// Caller (QoderTraceInput.collect) scopes segs per OTLP turn by sequential order.

const SESS = '303593aa-d7fb-44b7-a3fe-c6ca143be7bf';
const OTLP_TURN_T1 = '1df498c6-0c7f-4fbc-ba71-64137c0e44e9';
const SEG_TURN_T1 = '303593aa-d7fb-44b7-a3fe-c6ca143be7bf'; // segment turn_id for T1 = session ID

function makeRequest(overrides: Partial<AgentActivityEntry> = {}): AgentActivityEntry {
  return {
    'event.id': 'e-0',
    'event.name': 'llm.request',
    'gen_ai.session.id': SESS,
    'gen_ai.turn.id': OTLP_TURN_T1,
    'gen_ai.step.id': `${OTLP_TURN_T1}:s1`,
    'gen_ai.agent.type': 'qoder-cli',
    time_unix_nano: '1788260390500000000',
    'gen_ai.request.model': 'auto',
    ...overrides,
  } as AgentActivityEntry;
}

function makeResponse(overrides: Partial<AgentActivityEntry> = {}): AgentActivityEntry {
  return {
    'event.id': 'e-1',
    'event.name': 'llm.response',
    'gen_ai.session.id': SESS,
    'gen_ai.turn.id': OTLP_TURN_T1,
    'gen_ai.step.id': `${OTLP_TURN_T1}:s1`,
    'gen_ai.agent.type': 'qoder-cli',
    time_unix_nano: '1788260390500000000',
    'gen_ai.response.id': 'resp_0bfdfd26719a749f016a9680cc7f6c8194a84682cf40d8499c',
    ...overrides,
  } as AgentActivityEntry;
}

function makeSeg(overrides: Partial<SegmentTokenData> = {}): SegmentTokenData {
  return {
    requestId: 'c3be0573-f0d4-4347-b6a0-d9f8ec6d00ae',
    turnId: SEG_TURN_T1, // ≠ OTLP turn.id — this is the prod shape
    inputTokens: 5000,
    outputTokens: 200,
    cacheReadTokens: 3000,
    cacheCreationTokens: 0,
    requestStartTs: 1788260390875, // 10:59:50.875 (started)
    responseEndTs: 1788260397277,  // 10:59:57.277 (completed)
    toolFinishedTs: 0,
    stopReason: 'tool_use',
    model: 'claude-sonnet-4-5',
    ...overrides,
  };
}

describe('token-enricher prod-shape (seg.turnId ≠ OTLP turn.id)', () => {
  it('pairs seg.requestStartTs into llm.request.time_unix_nano despite turn.id mismatch', () => {
    // Reproduces tester Round 6 T1 LLM #1 symptom. seg.turnId = session ID,
    // OTLP turn.id = hook-derived UUID. Pass 1 (exact response.id) fails
    // (resp_xxx vs UUID). Pass 2 must pair segs with OTLP steps using the
    // OTLP turn.id prefix (from entries), NOT seg.turnId.
    // Caller pre-scopes segs to the current OTLP turn (sequential order pairing
    // in QoderTraceInput.collect), so all segs passed in belong to T1.
    const entries: AgentActivityEntry[] = [
      makeRequest({ 'gen_ai.step.id': `${OTLP_TURN_T1}:s1` }),
      makeResponse({ 'gen_ai.step.id': `${OTLP_TURN_T1}:s1` }),
    ];
    const segments: SegmentTokenData[] = [
      makeSeg({ requestId: 'uuid-t1-r0' }),
    ];

    enrichCliTurn(entries, segments);

    // CRITICAL: llm.request.time_unix_nano must be seg.requestStartTs (started)
    // NOT seg.responseEndTs (completed). If pairing fails, stays at hook
    // processor's fallback (= completed time → duration 0).
    const expected = String(BigInt(1788260390875) * 1_000_000n);
    expect(entries[0].time_unix_nano).toBe(expected);
    // llm.response gets seg.responseEndTs
    const expectedResp = String(BigInt(1788260397277) * 1_000_000n);
    expect(entries[1].time_unix_nano).toBe(expectedResp);
  });

  it('pairs multi-LLM turn (5 segs × 5 steps) by sequential order despite turn.id mismatch', () => {
    // T1 has 5 LLM calls. All segs have turnId=SEG_TURN_T1, OTLP step.ids
    // are ${OTLP_TURN_T1}:s1..s5. Pass 2 must pair seg[i] ↔ step :s(i+1)
    // by sequential order (sort by responseEndTs asc ↔ sort by step number asc).
    const entries: AgentActivityEntry[] = [];
    for (let i = 0; i < 5; i++) {
      const stepId = `${OTLP_TURN_T1}:s${i + 1}`;
      entries.push({
        'event.id': `e-req-${i}`,
        'event.name': 'llm.request',
        'gen_ai.session.id': SESS,
        'gen_ai.turn.id': OTLP_TURN_T1,
        'gen_ai.step.id': stepId,
        'gen_ai.agent.type': 'qoder-cli',
        time_unix_nano: '0',
        'gen_ai.request.model': 'auto',
      } as AgentActivityEntry);
      entries.push({
        'event.id': `e-resp-${i}`,
        'event.name': 'llm.response',
        'gen_ai.session.id': SESS,
        'gen_ai.turn.id': OTLP_TURN_T1,
        'gen_ai.step.id': stepId,
        'gen_ai.agent.type': 'qoder-cli',
        time_unix_nano: '0',
        'gen_ai.response.id': `resp_t1_s${i + 1}`,
      } as AgentActivityEntry);
    }
    const segments: SegmentTokenData[] = [];
    for (let i = 0; i < 5; i++) {
      segments.push(makeSeg({
        requestId: `uuid-t1-r${i}`,
        requestStartTs: 1788260390875 + i * 1000,
        responseEndTs: 1788260397277 + i * 1000,
      }));
    }

    enrichCliTurn(entries, segments);

    for (let i = 0; i < 5; i++) {
      const req = entries[i * 2];
      const resp = entries[i * 2 + 1];
      const expectedStart = String(BigInt(1788260390875 + i * 1000) * 1_000_000n);
      const expectedEnd = String(BigInt(1788260397277 + i * 1000) * 1_000_000n);
      expect(req.time_unix_nano).toBe(expectedStart);
      expect(resp.time_unix_nano).toBe(expectedEnd);
    }
  });
});
