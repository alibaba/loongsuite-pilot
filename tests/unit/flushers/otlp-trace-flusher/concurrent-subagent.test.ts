import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';

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

function makeConfig() {
  return {
    enabled: true,
    endpoint: 'http://localhost:4318',
    protocol: 'http/protobuf' as const,
    headers: { 'x-test': '1' },
    serviceName: 'test-pilot',
  };
}

function makeEntry(overrides: Record<string, unknown> = {}): AgentActivityEntry {
  return {
    'event.name': 'llm.response',
    'gen_ai.agent.type': 'mimo-code',
    'trace_id': '4bf92f3577b34da6a3ce929d0e0e4736',
    ...overrides,
  } as unknown as AgentActivityEntry;
}

describe('OtlpTraceFlusher - concurrent subagent regression', () => {
  let flusher: OtlpTraceFlusher;

  beforeEach(() => {
    flusher = new OtlpTraceFlusher(makeConfig());
  });

  afterEach(async () => {
    await flusher.shutdown();
  });

  it('does NOT split a turn\'s records across buffers when a concurrent subagent in a different session starts mid-stream', async () => {
    // Reproduces the multi-ENTRY/AGENT bug reported by the user (2026-07-16):
    // MiMo Code spawns a subagent (e.g. checkpoint-writer) in a SEPARATE
    // session while the main agent's turn is still streaming. The main
    // turn has already emitted an llm.response from an earlier step, so
    // the previous Signal B heuristic (hasLlmResponse → preempt) would
    // flush the main turn's buffer prematurely. When the main turn resumes
    // after the subagent returns, its late records create a NEW buffer
    // with the same turn_id (Signal B uses markFlushed=false), eventually
    // producing a second ENTRY/AGENT with the same trace_id.
    const { convertEventLogToTrace } = await import('@loongsuite/otel-util-genai');
    const mockConvert = vi.mocked(convertEventLogToTrace);
    mockConvert.mockClear();

    const mainTurnId = 'main-session:t1';
    const mainTraceId = 'aaaa2f3577b34da6a3ce929d0e0e4736';
    const subTurnId = 'sub-session:t1';
    const subTraceId = 'bbbb2f3577b34da6a3ce929d0e0e4736';

    // 1. Main agent turn starts. chat.message hook + step s1 (request+response).
    await flusher.send(makeEntry({
      'gen_ai.turn.id': mainTurnId,
      'gen_ai.session.id': 'main-session',
      'trace_id': mainTraceId,
      'event.name': 'other',
    }));
    await flusher.send(makeEntry({
      'gen_ai.turn.id': mainTurnId,
      'gen_ai.session.id': 'main-session',
      'trace_id': mainTraceId,
      'event.name': 'llm.request',
      'gen_ai.step.id': `${mainTurnId}:s1`,
    }));
    await flusher.send(makeEntry({
      'gen_ai.turn.id': mainTurnId,
      'gen_ai.session.id': 'main-session',
      'trace_id': mainTraceId,
      'event.name': 'llm.response',
      'gen_ai.step.id': `${mainTurnId}:s1`,
      'gen_ai.response.finish_reasons': ['tool_call'],
    }));
    expect(mockConvert).not.toHaveBeenCalled();

    // 2. Subagent (DIFFERENT session, DIFFERENT turn_id, DIFFERENT trace_id)
    //    starts concurrently. Its first record must NOT preempt the main
    //    turn's buffer.
    await flusher.send(makeEntry({
      'gen_ai.turn.id': subTurnId,
      'gen_ai.session.id': 'sub-session',
      'trace_id': subTraceId,
      'event.name': 'other',
    }));
    await flusher.send(makeEntry({
      'gen_ai.turn.id': subTurnId,
      'gen_ai.session.id': 'sub-session',
      'trace_id': subTraceId,
      'event.name': 'llm.request',
      'gen_ai.step.id': `${subTurnId}:s1`,
    }));
    // Main turn's buffer must NOT have been flushed (concurrent subagent
    // in a different session must not preempt it).
    expect(mockConvert).not.toHaveBeenCalled();

    // 3. Subagent completes (terminal llm.response with stop) → flush subagent.
    await flusher.send(makeEntry({
      'gen_ai.turn.id': subTurnId,
      'gen_ai.session.id': 'sub-session',
      'trace_id': subTraceId,
      'event.name': 'llm.response',
      'gen_ai.step.id': `${subTurnId}:s1`,
      'gen_ai.response.finish_reasons': ['stop'],
    }));
    // Subagent's buffer should be flushed exactly once.
    expect(mockConvert).toHaveBeenCalledTimes(1);
    const subRecords = mockConvert.mock.calls[0][0];
    expect(subRecords).toHaveLength(3);
    // All flushed records belong to the subagent turn.
    for (const r of subRecords) {
      expect((r as Record<string, unknown>)['gen_ai.turn.id']).toBe(subTurnId);
    }

    // 4. Main agent resumes (subagent returned). Step s2 arrives.
    await flusher.send(makeEntry({
      'gen_ai.turn.id': mainTurnId,
      'gen_ai.session.id': 'main-session',
      'trace_id': mainTraceId,
      'event.name': 'llm.request',
      'gen_ai.step.id': `${mainTurnId}:s2`,
    }));
    await flusher.send(makeEntry({
      'gen_ai.turn.id': mainTurnId,
      'gen_ai.session.id': 'main-session',
      'trace_id': mainTraceId,
      'event.name': 'llm.response',
      'gen_ai.step.id': `${mainTurnId}:s2`,
      'gen_ai.response.finish_reasons': ['stop'],
    }));

    // Main turn must produce EXACTLY ONE conversion call (not two) covering
    // ALL 5 of its records (other + s1.request + s1.response + s2.request +
    // s2.response). Two conversion calls would mean the main turn was split
    // across buffers → multi-ENTRY/AGENT in the same trace_id.
    // Drain in-flight exports (Signal A's flushSingleTurn runs async).
    await flusher.flush();
    expect(mockConvert).toHaveBeenCalledTimes(2);
    const mainRecords = mockConvert.mock.calls[1][0];
    expect(mainRecords).toHaveLength(5);
    for (const r of mainRecords) {
      expect((r as Record<string, unknown>)['gen_ai.turn.id']).toBe(mainTurnId);
      expect((r as Record<string, unknown>)['trace_id']).toBe(mainTraceId);
    }
  });
});
