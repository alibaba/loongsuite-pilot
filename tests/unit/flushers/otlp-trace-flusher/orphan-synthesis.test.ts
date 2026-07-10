import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';
import type { AgentActivityEntry, JsonValue } from '../../../../src/types/index.js';
import { convertEventLogToTrace } from '@loongsuite/otel-util-genai';

vi.mock('@loongsuite/otel-util-genai', () => ({
  convertEventLogToTrace: vi.fn(() => ({ traceIds: [], spanCount: 0, warnings: [] })),
  ExtendedTelemetryHandler: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@opentelemetry/exporter-trace-otlp-proto', () => ({
  OTLPTraceExporter: vi.fn().mockImplementation(() => ({
    export: vi.fn((_spans, cb) => cb({ code: 0 })),
    shutdown: vi.fn().mockResolvedValue(undefined),
  })),
}));

// fixture source: synthetic zcode-shaped entries mirroring the long-conv
// round3 failure path (hook tool.call with no matching rollout llm.response
// because Signal A fired before rollout poll caught up). Field structure
// matches zcode-hook-processor.mjs output (verified against existing
// hook-processor.test.mjs fixtures).

function makeConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    endpoint: 'http://localhost:4318',
    protocol: 'http/protobuf' as const,
    headers: { 'x-test': '1' },
    serviceName: 'test-pilot',
    ...overrides,
  };
}

function makeToolCall(callId: string, toolName: string, ts: number): AgentActivityEntry {
  return {
    'event.name': 'tool.call',
    'event.id': `evt-call-${callId}`,
    'gen_ai.agent.type': 'zcode',
    'gen_ai.session.id': 'sess_test',
    'gen_ai.turn.id': 'turn_test',
    'gen_ai.tool.name': toolName,
    'gen_ai.tool.call.id': callId,
    'gen_ai.tool.call.arguments': { path: '/tmp/x' },
    time_unix_nano: String(ts) + '000000',
    timestamp: ts,
  } as unknown as AgentActivityEntry;
}

function makeLlmResponse(finishReasons: string[], ts: number): AgentActivityEntry {
  return {
    'event.name': 'llm.response',
    'event.id': `evt-resp-${ts}`,
    'gen_ai.agent.type': 'zcode',
    'gen_ai.session.id': 'sess_test',
    'gen_ai.turn.id': 'turn_test',
    'gen_ai.request.id': 'req_existing',
    'gen_ai.response.id': 'resp_existing',
    'gen_ai.response.finish_reasons': finishReasons,
    time_unix_nano: String(ts) + '000000',
    timestamp: ts,
  } as unknown as AgentActivityEntry;
}

describe('OtlpTraceFlusher - zcode orphan synthesis (P0-1/P0-2/P2-7)', () => {
  let flusher: OtlpTraceFlusher;

  beforeEach(() => {
    vi.mocked(convertEventLogToTrace).mockClear();
  });

  afterEach(async () => {
    if (flusher) await flusher.shutdown();
  });

  it('orphan tool.call (no llm.response, no tool.result): synthesizes parent LLM + error tool.result', async () => {
    flusher = new OtlpTraceFlusher(makeConfig() as any);
    // Signal A terminal flush triggers on 'stop' finish_reason
    const terminalResp = makeLlmResponse(['stop'], 5000);
    // Orphan tool.call from hook side — its callId is NOT in any llm.response
    const orphan = makeToolCall('call_orphan_1', 'Read', 4000);

    await flusher.sendBatch([orphan, terminalResp]);
    await flusher.flush();

    // Verify exportSpy was called with spans (the converter mock returns 0,
    // so we instead verify the convertEventLogToTrace mock was called with
    // synthesized records).
    
    const calls = vi.mocked(convertEventLogToTrace).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const lastCallRecords = calls[calls.length - 1][0] as any[];
    // Original 2 + synthesized: 1 tool.result + 1 llm.request + 1 llm.response = 5
    expect(lastCallRecords.length).toBe(5);
    const synthesizedResults = lastCallRecords.filter(
      (r) => r['event.name'] === 'tool.result',
    );
    expect(synthesizedResults).toHaveLength(1);
    expect(synthesizedResults[0]['gen_ai.tool.call.status']).toBe('error');
    expect(synthesizedResults[0]['error.type']).toBe('orphaned');
    expect(synthesizedResults[0]['error.message']).toBeTruthy();
    const synthLlmResponses = lastCallRecords.filter(
      (r) => r['event.name'] === 'llm.response' && r['gen_ai.response.id']?.startsWith('synthetic-resp-'),
    );
    expect(synthLlmResponses).toHaveLength(1);
    expect(synthLlmResponses[0]['gen_ai.response.finish_reasons']).toEqual(['tool_calls']);
    // Verify orphan tool.call got backfilled with synthetic step.id
    const orphanRec = lastCallRecords.find(
      (r) => r['event.name'] === 'tool.call' && r['gen_ai.tool.call.id'] === 'call_orphan_1',
    );
    expect(orphanRec['gen_ai.step.id']).toMatch(/turn_test:synthetic-\d+/);
  });

  it('tool.call WITH matching tool.result but no llm.response: synthesize llm pair only (no duplicate tool.result)', async () => {
    flusher = new OtlpTraceFlusher(makeConfig() as any);
    const call = makeToolCall('call_resolved', 'Read', 4000);
    const result: AgentActivityEntry = {
      'event.name': 'tool.result',
      'gen_ai.agent.type': 'zcode',
      'gen_ai.session.id': 'sess_test',
      'gen_ai.turn.id': 'turn_test',
      'gen_ai.tool.call.id': 'call_resolved',
      'gen_ai.tool.name': 'Read',
      time_unix_nano: String(4001) + '000000',
      timestamp: 4001,
    } as unknown as AgentActivityEntry;
    const terminal = makeLlmResponse(['stop'], 5000);

    await flusher.sendBatch([call, result, terminal]);
    await flusher.flush();

    const calls = vi.mocked(convertEventLogToTrace).mock.calls;
    const lastCallRecords = calls[calls.length - 1][0] as any[];
    // 3 original + synthesized llm.request + llm.response = 5 (no duplicate tool.result)
    expect(lastCallRecords.length).toBe(5);
    const toolResults = lastCallRecords.filter((r) => r['event.name'] === 'tool.result');
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]['gen_ai.tool.call.id']).toBe('call_resolved');
    const synthLlm = lastCallRecords.filter(
      (r) => r['event.name'] === 'llm.response' && typeof r['gen_ai.response.id'] === 'string' && r['gen_ai.response.id'].startsWith('synthetic-resp-'),
    );
    expect(synthLlm).toHaveLength(1);
  });

  it('multiple orphan tool.calls in one turn: single synthesized LLM with N tool_call parts', async () => {
    flusher = new OtlpTraceFlusher(makeConfig() as any);
    const orphans = [
      makeToolCall('call_a', 'Read', 4000),
      makeToolCall('call_b', 'Bash', 4005),
      makeToolCall('call_c', 'Bash', 4010),
    ];
    const terminal = makeLlmResponse(['stop'], 5000);

    await flusher.sendBatch([...orphans, terminal]);
    await flusher.flush();

    
    const calls = vi.mocked(convertEventLogToTrace).mock.calls;
    const lastCallRecords = calls[calls.length - 1][0] as any[];
    const synthLlmResp = lastCallRecords.find(
      (r) => r['event.name'] === 'llm.response' && r['gen_ai.response.id']?.startsWith('synthetic-resp-'),
    );
    expect(synthLlmResp).toBeTruthy();
    const outMsgs = synthLlmResp['gen_ai.output.messages'];
    expect(Array.isArray(outMsgs)).toBe(true);
    expect(outMsgs[0].parts.length).toBe(3);
    const ids = outMsgs[0].parts.map((p: any) => p.id).sort();
    expect(ids).toEqual(['call_a', 'call_b', 'call_c']);
  });

  it('non-zcode agent buffer: no synthesis', async () => {
    flusher = new OtlpTraceFlusher(makeConfig() as any);
    const orphan: AgentActivityEntry = {
      'event.name': 'tool.call',
      'gen_ai.agent.type': 'claude-code',
      'gen_ai.session.id': 'sess_other',
      'gen_ai.turn.id': 'turn_other',
      'gen_ai.tool.call.id': 'call_other',
      time_unix_nano: String(4000) + '000000',
      timestamp: 4000,
    } as unknown as AgentActivityEntry;
    const terminal: AgentActivityEntry = {
      'event.name': 'llm.response',
      'gen_ai.agent.type': 'claude-code',
      'gen_ai.session.id': 'sess_other',
      'gen_ai.turn.id': 'turn_other',
      'gen_ai.response.finish_reasons': ['stop'],
      time_unix_nano: String(5000) + '000000',
      timestamp: 5000,
    } as unknown as AgentActivityEntry;

    await flusher.sendBatch([orphan, terminal]);
    await flusher.flush();

    
    const calls = vi.mocked(convertEventLogToTrace).mock.calls;
    const lastCallRecords = calls[calls.length - 1][0] as any[];
    // 2 original, no synthesis
    expect(lastCallRecords.length).toBe(2);
    expect(lastCallRecords.find((r) => r['gen_ai.response.id']?.startsWith('synthetic-resp-'))).toBeUndefined();
  });

  // S2 failure path (Round 2 E2E): Read tool.call has a real step.id from a
  // real llm.response (callId resolved by resolver), but ZCode never emitted
  // a tool.result event for it. Without synthesis the OTLP converter's
  // pairTool() falls back to "first unconsumed result" and routes Bash's
  // result payload to the Read TOOL span — leaving Bash with empty result +
  // 0ms duration. The fix synthesizes an error tool.result keyed by Read's
  // callId so pairTool pairs correctly, AND does NOT synthesize a duplicate
  // LLM pair (Read already has a real parent llm.response with a step.id).
  it('tool.call WITH resolved step.id but missing tool.result: synthesizes only error tool.result (no LLM pair)', async () => {
    flusher = new OtlpTraceFlusher(makeConfig() as any);
    const call = makeToolCall('call_resolved_missing_result', 'Read', 4000);
    // Real llm.response that declared this Read tool_call — gives the call a step.id
    // and pulls its callId out of the resolver's unresolved set.
    const llmResp: AgentActivityEntry = {
      'event.name': 'llm.response',
      'event.id': 'evt-resp-real',
      'gen_ai.agent.type': 'zcode',
      'gen_ai.session.id': 'sess_test',
      'gen_ai.turn.id': 'turn_test',
      'gen_ai.request.id': 'req_real',
      'gen_ai.response.id': 'resp_real',
      'gen_ai.step.id': 's_real',
      'gen_ai.response.finish_reasons': ['tool_calls'],
      'gen_ai.output.messages': [{
        role: 'assistant',
        parts: [
          { type: 'tool_call', id: 'call_resolved_missing_result', name: 'Read', input: { path: '/tmp/x' } },
          { type: 'tool_call', id: 'call_bash', name: 'Bash', input: { command: 'echo 4' } },
        ],
        finish_reason: 'tool_calls',
      }] as unknown as JsonValue,
      time_unix_nano: String(3999) + '000000',
      timestamp: 3999,
    } as unknown as AgentActivityEntry;
    // Sibling Bash tool.call WITH its real tool.result — must NOT be
    // routed to Read's TOOL span.
    const bashCall = makeToolCall('call_bash', 'Bash', 5000);
    const bashResult: AgentActivityEntry = {
      'event.name': 'tool.result',
      'gen_ai.agent.type': 'zcode',
      'gen_ai.session.id': 'sess_test',
      'gen_ai.turn.id': 'turn_test',
      'gen_ai.step.id': 's_real',
      'gen_ai.tool.call.id': 'call_bash',
      'gen_ai.tool.name': 'Bash',
      'gen_ai.tool.call.status': 'success',
      time_unix_nano: String(5001) + '000000',
      timestamp: 5001,
    } as unknown as AgentActivityEntry;
    // Terminal llm.response to trigger flush
    const terminal = makeLlmResponse(['stop'], 6000);

    await flusher.sendBatch([llmResp, call, bashCall, bashResult, terminal]);
    await flusher.flush();

    const calls = vi.mocked(convertEventLogToTrace).mock.calls;
    const lastCallRecords = calls[calls.length - 1][0] as any[];
    // Synthesized tool.result for the missing-result Read call
    const synthResults = lastCallRecords.filter(
      (r) => r['event.name'] === 'tool.result' && r['gen_ai.tool.call.id'] === 'call_resolved_missing_result',
    );
    expect(synthResults).toHaveLength(1);
    expect(synthResults[0]['gen_ai.tool.call.status']).toBe('error');
    expect(synthResults[0]['error.type']).toBe('orphaned');
    expect(synthResults[0]['error.message']).toBeTruthy();
    // Bash's real result is preserved unchanged
    const bashResults = lastCallRecords.filter(
      (r) => r['event.name'] === 'tool.result' && r['gen_ai.tool.call.id'] === 'call_bash',
    );
    expect(bashResults).toHaveLength(1);
    expect(bashResults[0]['gen_ai.tool.call.status']).toBe('success');
    // NO synthetic LLM pair — both Read and Bash already have a real parent
    // llm.response (llmResp above declares both callIds), so neither is in
    // the resolver's unresolved set.
    const synthLlm = lastCallRecords.filter(
      (r) => r['event.name'] === 'llm.response' && typeof r['gen_ai.response.id'] === 'string' && r['gen_ai.response.id'].startsWith('synthetic-resp-'),
    );
    expect(synthLlm).toHaveLength(0);
  });
});
