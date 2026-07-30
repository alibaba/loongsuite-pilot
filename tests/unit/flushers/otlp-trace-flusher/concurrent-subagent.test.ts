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
    endpoints: [{ name: 'primary', endpoint: 'http://localhost:4318', headers: { 'x-test': '1' } }],
    protocol: 'http/protobuf' as const,
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

  it('preempts an abandoned same-session buffer with no llm.response when a new same-session turn arrives', async () => {
    // PR #115 review issue 3: an abandoned same-session turn that only has
    // llm.request / tool.call records (the user moved on or MiMo crashed
    // mid-stream) must be flushed when a new same-session turn arrives —
    // otherwise it accumulates forever (turnIdleTimeoutMs defaults to 0).
    // Same-session signals "user moved on" so the hasLlmResponse guard is
    // dropped for this case. Different-session (concurrent subagent) is
    // still covered by the test above.
    const { convertEventLogToTrace } = await import('@loongsuite/otel-util-genai');
    const mockConvert = vi.mocked(convertEventLogToTrace);
    mockConvert.mockClear();

    const trace1 = '11112f3577b34da6a3ce929d0e0e4736';
    const trace2 = '22222f3577b34da6a3ce929d0e0e4736';

    // Abandoned turn in session "s1" — only an `other` event (no llm.request/
    // llm.response pair, no tool pair). The orphan-pair dropper passes
    // `other` records through unchanged, so we can assert the preempt
    // forwarded this exact record.
    await flusher.send(makeEntry({
      'gen_ai.turn.id': 's1:t1',
      'gen_ai.session.id': 's1',
      'trace_id': trace1,
      'event.name': 'other',
    }));
    expect(mockConvert).not.toHaveBeenCalled();

    // New same-session turn arrives — the abandoned buffer must be preempted
    // even though it never emitted llm.response.
    await flusher.send(makeEntry({
      'gen_ai.turn.id': 's1:t2',
      'gen_ai.session.id': 's1',
      'trace_id': trace2,
      'event.name': 'other',
    }));
    await flusher.flush();
    // The first call is the preempt of the abandoned s1:t1 buffer (the
    // second is the shutdown flush of the s1:t2 buffer that arrived last).
    expect(mockConvert.mock.calls.length).toBeGreaterThanOrEqual(1);
    const abandonedRecords = mockConvert.mock.calls[0][0];
    expect(abandonedRecords).toHaveLength(1);
    expect((abandonedRecords[0] as Record<string, unknown>)['gen_ai.turn.id']).toBe('s1:t1');
  });

  it('does NOT preempt an abandoned buffer with no llm.response when session info is missing', async () => {
    // When gen_ai.session.id is missing on either side, we can't tell
    // same-session (sequential, safe to preempt) from different-session
    // (concurrent subagent, must not preempt). Fall back to the original
    // hasLlmResponse safety check so an in-progress turn isn't split on
    // every sibling arrival.
    const { convertEventLogToTrace } = await import('@loongsuite/otel-util-genai');
    const mockConvert = vi.mocked(convertEventLogToTrace);
    mockConvert.mockClear();

    const trace1 = '33332f3577b34da6a3ce929d0e0e4736';
    const trace2 = '44442f3577b34da6a3ce929d0e0e4736';

    // Abandoned turn, NO gen_ai.session.id on any record — only an other event.
    await flusher.send(makeEntry({
      'gen_ai.turn.id': 'no-ses:t1',
      'trace_id': trace1,
      'event.name': 'other',
    }));
    // New turn arrives, also without gen_ai.session.id — must NOT preempt
    // (hasLlmResponse guard still applies when session info is missing).
    await flusher.send(makeEntry({
      'gen_ai.turn.id': 'no-ses:t2',
      'trace_id': trace2,
      'event.name': 'other',
    }));
    // No preemption should have fired before shutdown flush.
    expect(mockConvert).not.toHaveBeenCalled();
  });

  it('force-flushes oldest incomplete buffers when MAX_TURN_BUFFERS is exceeded', async () => {
    // Bounded cleanup: if buffers accumulate past the hard cap (neither
    // Signal A, same-session successor, nor idle timeout ever fires for
    // many turns), the oldest incomplete buffers must be force-flushed to
    // bound memory. Each turn is in its own session and never emits
    // llm.response, so neither Signal A nor same-session preempt applies.
    const { convertEventLogToTrace } = await import('@loongsuite/otel-util-genai');
    const mockConvert = vi.mocked(convertEventLogToTrace);
    mockConvert.mockClear();

    // Push 70 distinct abandoned buffers (all different sessions, only an
    // `other` event so they survive orphan-dropping and we can count calls).
    for (let i = 0; i < 70; i++) {
      const hex = i.toString(16).padStart(8, '0').slice(-8);
      const trace = (hex + '2f3577b34da6a3ce929d0e0e4736').slice(0, 32);
      await flusher.send(makeEntry({
        'gen_ai.turn.id': `s${i}:t1`,
        'gen_ai.session.id': `s${i}`,
        'trace_id': trace,
        'event.name': 'other',
      }));
    }
    await flusher.flush();
    // At least the overflow (70 - 64 = 6) oldest buffers must have been
    // force-flushed to stay under the cap.
    expect(mockConvert.mock.calls.length).toBeGreaterThanOrEqual(6);
  });
});
