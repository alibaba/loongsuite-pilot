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

  it('keeps interleaved Codex sessions isolated until their own stop signals', async () => {
    const { convertEventLogToTrace } = await import('@loongsuite/otel-util-genai');
    const mockConvert = vi.mocked(convertEventLogToTrace);
    mockConvert.mockClear();

    const a = {
      'gen_ai.agent.type': 'codex',
      'gen_ai.turn.id': 'codex-session-a:t1',
      'gen_ai.session.id': 'codex-session-a',
      'trace_id': '77772f3577b34da6a3ce929d0e0e4736',
    };
    const b = {
      'gen_ai.agent.type': 'codex',
      'gen_ai.turn.id': 'codex-session-b:t1',
      'gen_ai.session.id': 'codex-session-b',
      'trace_id': '88882f3577b34da6a3ce929d0e0e4736',
    };

    await flusher.send(makeEntry({ ...a, 'event.name': 'other' }));
    await flusher.send(makeEntry({
      ...a,
      'event.name': 'llm.response',
      'gen_ai.response.finish_reasons': ['tool_call'],
    }));
    await flusher.send(makeEntry({ ...b, 'event.name': 'other' }));
    await flusher.send(makeEntry({ ...a, 'event.name': 'llm.request' }));
    expect(mockConvert).not.toHaveBeenCalled();

    await flusher.send(makeEntry({
      ...b,
      'event.name': 'llm.response',
      'gen_ai.response.finish_reasons': ['stop'],
    }));
    await flusher.send(makeEntry({
      ...a,
      'event.name': 'llm.response',
      'gen_ai.response.finish_reasons': ['stop'],
    }));
    await flusher.flush();

    expect(mockConvert).toHaveBeenCalledTimes(2);
    const recordsByTurn = new Map(
      mockConvert.mock.calls.map(([records]) => [
        (records[0] as Record<string, unknown>)['gen_ai.turn.id'],
        records,
      ]),
    );
    expect(recordsByTurn.get(a['gen_ai.turn.id'])).toHaveLength(4);
    expect(recordsByTurn.get(b['gen_ai.turn.id'])).toHaveLength(2);
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

  it('does NOT preempt when both session ids are missing', async () => {
    // Without two known session ids, Signal B cannot prove that the turns
    // are sequential rather than concurrent.
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
    // New turn arrives, also without gen_ai.session.id — keep both buffers
    // open until their own terminal/idle/cap/shutdown signal.
    await flusher.send(makeEntry({
      'gen_ai.turn.id': 'no-ses:t2',
      'trace_id': trace2,
      'event.name': 'other',
    }));
    expect(mockConvert).not.toHaveBeenCalled();
  });

  it('does NOT preempt a known-session buffer when the incoming session is missing', async () => {
    const { convertEventLogToTrace } = await import('@loongsuite/otel-util-genai');
    const mockConvert = vi.mocked(convertEventLogToTrace);
    mockConvert.mockClear();

    await flusher.send(makeEntry({
      'gen_ai.turn.id': 'known-session:t1',
      'gen_ai.session.id': 'known-session',
      'trace_id': '99992f3577b34da6a3ce929d0e0e4736',
      'event.name': 'other',
    }));
    await flusher.send(makeEntry({
      'gen_ai.turn.id': 'unknown-session:t1',
      'trace_id': 'aaaa3f3577b34da6a3ce929d0e0e4736',
      'event.name': 'other',
    }));

    expect(mockConvert).not.toHaveBeenCalled();
  });

  it('does NOT preempt an unknown-session buffer when the incoming session is known', async () => {
    const { convertEventLogToTrace } = await import('@loongsuite/otel-util-genai');
    const mockConvert = vi.mocked(convertEventLogToTrace);
    mockConvert.mockClear();

    await flusher.send(makeEntry({
      'gen_ai.turn.id': 'unknown-session:t1',
      'trace_id': 'bbbb3f3577b34da6a3ce929d0e0e4736',
      'event.name': 'other',
    }));
    await flusher.send(makeEntry({
      'gen_ai.turn.id': 'known-session:t1',
      'gen_ai.session.id': 'known-session',
      'trace_id': 'cccc3f3577b34da6a3ce929d0e0e4736',
      'event.name': 'other',
    }));

    expect(mockConvert).not.toHaveBeenCalled();
  });

  it('learns a session id from later records before applying Signal B', async () => {
    const { convertEventLogToTrace } = await import('@loongsuite/otel-util-genai');
    const mockConvert = vi.mocked(convertEventLogToTrace);
    mockConvert.mockClear();

    const mainTurnId = 'late-session:t1';
    const mainTraceId = '55552f3577b34da6a3ce929d0e0e4736';

    // The first record has no session id, but a later record for the same
    // turn supplies it. The buffer should retain that identity.
    await flusher.send(makeEntry({
      'gen_ai.turn.id': mainTurnId,
      'trace_id': mainTraceId,
      'event.name': 'other',
    }));
    await flusher.send(makeEntry({
      'gen_ai.turn.id': mainTurnId,
      'gen_ai.session.id': 'late-session',
      'trace_id': mainTraceId,
      'event.name': 'llm.response',
      'gen_ai.response.finish_reasons': ['tool_call'],
    }));

    // A different known session must not preempt the first turn.
    await flusher.send(makeEntry({
      'gen_ai.turn.id': 'parallel-session:t1',
      'gen_ai.session.id': 'parallel-session',
      'trace_id': '66662f3577b34da6a3ce929d0e0e4736',
      'event.name': 'other',
    }));
    expect(mockConvert).not.toHaveBeenCalled();
  });

  // Qoder CLI is collected by two inputs at once while qoder-trace is off:
  // qoder-transcript-hook (turn id = crypto.randomUUID()) and
  // qoder-cli-session-segment (turn id = record.turn_id). They share the
  // session id but mint turn ids from separate id spaces, so their buffers
  // are concurrent, not successive. Preempting across paths truncated the
  // hook buffer down to its turn-entry `other`, which the converter turns
  // into a phantom ENTRY+AGENT pair with no turn/step/llm children.
  //
  // The two paths group under different key shapes, and that shape changes with
  // #342, so both are covered below: Signal B walks every buffer of the same
  // agent+session regardless of key shape, and the guard must hold either way.
  const QODER_SESSION = 'qoder-cli-session-1';
  const QODER_HOOK = {
    'gen_ai.agent.type': 'qoder-cli',
    'gen_ai.session.id': QODER_SESSION,
    'gen_ai.turn.id': 'c0ffee00-0000-4000-8000-000000000001',
    'agent.source': 'qoder-transcript-hook',
    // The hook processor writes no trace_id, so turn.id decides the key.
    'trace_id': undefined,
  };

  function findCall(
    mockConvert: { mock: { calls: unknown[][] } },
    source: string,
  ): Record<string, unknown>[] | undefined {
    const call = mockConvert.mock.calls.find(
      (args) => ((args[0] as Record<string, unknown>[])[0])['agent.source'] === source,
    );
    return call?.[0] as Record<string, unknown>[] | undefined;
  }

  it('does NOT let the session-keyed segment path preempt the hook path in the same session', async () => {
    // Production shape on this branch: qoder-cli-session-segment stamps neither
    // gen_ai.turn.id nor trace_id — no input writes trace_id for Qoder CLI and
    // upstreamLink is off by default — so its records fall through
    // resolveGroupKey to `session:<sid>` while the hook path uses `turn:<uuid>`.
    // This is the shape CI must cover until #342 lands.
    const { convertEventLogToTrace } = await import('@loongsuite/otel-util-genai');
    const mockConvert = vi.mocked(convertEventLogToTrace);
    mockConvert.mockClear();

    const segment = {
      'gen_ai.agent.type': 'qoder-cli',
      'gen_ai.session.id': QODER_SESSION,
      'agent.source': 'qoder-cli-session-segment',
      'trace_id': undefined,
    };

    // Hook turn opens with the entry `other` carrying the user prompt.
    await flusher.send(makeEntry({ ...QODER_HOOK, 'event.name': 'other' }));
    // Segment path emits a record for the same session mid-stream. `tool_call`
    // is not in TERMINAL_FINISH_REASONS, so Signal A does not fire here.
    await flusher.send(makeEntry({
      ...segment,
      'event.name': 'llm.response',
      'gen_ai.response.finish_reasons': ['tool_call'],
    }));
    // The hook buffer must still be open — nothing flushed yet.
    expect(mockConvert).not.toHaveBeenCalled();

    // The segment buffer really is session-keyed, and on this branch it has no
    // closer of its own: no terminal finish reason (that is what #342 supplies)
    // and turnIdleTimeoutMs defaults to 0, leaving only the 64-buffer cap and
    // shutdown. Read through the internal map because no public API exposes a
    // buffer's key or completion state, and because triggerFlush deletes the
    // buffer synchronously — so this observation cannot race the async export.
    const buffers = (flusher as unknown as {
      turnBuffers: Map<string, { completed: boolean }>;
    }).turnBuffers;
    expect([...buffers.keys()]).toContain(`session:${QODER_SESSION}`);
    expect(buffers.get(`session:${QODER_SESSION}`)!.completed).toBe(false);

    // Hook turn finishes on its own signal.
    await flusher.send(makeEntry({ ...QODER_HOOK, 'event.name': 'llm.request' }));
    await flusher.send(makeEntry({
      ...QODER_HOOK,
      'event.name': 'llm.response',
      'gen_ai.response.finish_reasons': ['stop'],
    }));
    await flusher.flush();

    // All three hook records converted together — not an `other`-only skeleton.
    const hookRecords = findCall(mockConvert, 'qoder-transcript-hook');
    expect(hookRecords).toBeDefined();
    expect(hookRecords).toHaveLength(3);
    // And the segment payload is intact rather than dropped: the guard prevents
    // preemption, it does not discard the other path's records.
    const segmentRecords = findCall(mockConvert, 'qoder-cli-session-segment');
    expect(segmentRecords).toBeDefined();
    expect(segmentRecords).toHaveLength(1);
  });

  it('does NOT let the turn-keyed segment path preempt the hook path once #342 lands', async () => {
    // After #342 the segment input lifts turn_id and finish_reasons to
    // top-level fields, so its records group under `turn:<record.turn_id>` and
    // close on Signal A. This PR merges after #342, so that is the shape
    // production will actually run — the guard has to hold there too, and the
    // two turn ids still come from unrelated id spaces.
    const { convertEventLogToTrace } = await import('@loongsuite/otel-util-genai');
    const mockConvert = vi.mocked(convertEventLogToTrace);
    mockConvert.mockClear();

    const segment = {
      'gen_ai.agent.type': 'qoder-cli',
      'gen_ai.session.id': QODER_SESSION,
      'gen_ai.turn.id': 'segment-turn-7',
      'agent.source': 'qoder-cli-session-segment',
      'trace_id': undefined,
    };

    await flusher.send(makeEntry({ ...QODER_HOOK, 'event.name': 'other' }));
    await flusher.send(makeEntry({
      ...segment,
      'event.name': 'llm.request',
    }));
    await flusher.send(makeEntry({ ...QODER_HOOK, 'event.name': 'llm.request' }));
    expect(mockConvert).not.toHaveBeenCalled();

    // Each path now closes on its own Signal A, in interleaved order.
    await flusher.send(makeEntry({
      ...segment,
      'event.name': 'llm.response',
      'gen_ai.response.finish_reasons': ['end_turn'],
    }));
    await flusher.send(makeEntry({
      ...QODER_HOOK,
      'event.name': 'llm.response',
      'gen_ai.response.finish_reasons': ['stop'],
    }));
    await flusher.flush();

    // Neither path truncated the other: both payloads are complete.
    expect(findCall(mockConvert, 'qoder-transcript-hook')).toHaveLength(3);
    expect(findCall(mockConvert, 'qoder-cli-session-segment')).toHaveLength(2);
  });

  it('does NOT let a hook turn preempt a segment buffer that opened first', async () => {
    // Mirror image of the hook-first case. Signal B is evaluated on the
    // incoming record, so whichever path arrives second is the one doing the
    // preempting — the hook's records must not close a segment buffer either.
    // Ordering between the two inputs is not controlled by anything, so both
    // directions occur in the field.
    const { convertEventLogToTrace } = await import('@loongsuite/otel-util-genai');
    const mockConvert = vi.mocked(convertEventLogToTrace);
    mockConvert.mockClear();

    const segment = {
      'gen_ai.agent.type': 'qoder-cli',
      'gen_ai.session.id': QODER_SESSION,
      'agent.source': 'qoder-cli-session-segment',
      'trace_id': undefined,
    };

    // Segment path opens first, with a non-terminal response.
    await flusher.send(makeEntry({
      ...segment,
      'event.name': 'llm.response',
      'gen_ai.response.finish_reasons': ['tool_call'],
    }));
    // Hook turn starts mid-stream and runs to its own terminal record.
    await flusher.send(makeEntry({ ...QODER_HOOK, 'event.name': 'other' }));
    await flusher.send(makeEntry({
      ...segment,
      'event.name': 'llm.request',
    }));
    await flusher.send(makeEntry({
      ...QODER_HOOK,
      'event.name': 'llm.response',
      'gen_ai.response.finish_reasons': ['stop'],
    }));
    await flusher.flush();

    // Both payloads survive intact: the segment buffer kept both of its records
    // instead of being cut in half by the hook turn starting.
    expect(findCall(mockConvert, 'qoder-cli-session-segment')).toHaveLength(2);
    expect(findCall(mockConvert, 'qoder-transcript-hook')).toHaveLength(2);
  });

  it('still preempts within one collection path', async () => {
    // The same-source guard must not disable Signal B: two successive turns
    // from the same input are still sequential, so the abandoned one closes.
    const { convertEventLogToTrace } = await import('@loongsuite/otel-util-genai');
    const mockConvert = vi.mocked(convertEventLogToTrace);
    mockConvert.mockClear();

    const base = {
      'gen_ai.agent.type': 'qoder-cli',
      'gen_ai.session.id': 'same-path-session',
      'agent.source': 'qoder-transcript-hook',
    };

    await flusher.send(makeEntry({
      ...base,
      'gen_ai.turn.id': 'hook-turn-1',
      'trace_id': 'fff12f3577b34da6a3ce929d0e0e4736',
      'event.name': 'other',
    }));
    await flusher.send(makeEntry({
      ...base,
      'gen_ai.turn.id': 'hook-turn-2',
      'trace_id': 'fff22f3577b34da6a3ce929d0e0e4736',
      'event.name': 'other',
    }));

    expect(mockConvert).toHaveBeenCalledTimes(1);
    const preempted = mockConvert.mock.calls[0][0];
    expect((preempted[0] as Record<string, unknown>)['gen_ai.turn.id']).toBe('hook-turn-1');
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
