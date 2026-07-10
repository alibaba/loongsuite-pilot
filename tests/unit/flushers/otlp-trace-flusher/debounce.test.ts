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

// fixture source: plan 2.2 — synthetic entries shaped like zcode-rollout
// output (gen_ai.turn.id + gen_ai.response.finish_reasons). Field structure
// matches what zcode-rollout-input.ts emits (verified against existing
// zcode-rollout-input.test.ts fixtures).

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

function makeZcodeEntry(overrides: Record<string, unknown> = {}): AgentActivityEntry {
  return {
    'event.name': 'llm.response',
    'gen_ai.agent.type': 'zcode',
    'gen_ai.turn.id': 'turn_test',
    'trace_id': '4bf92f3577b34da6a3ce929d0e0e4736',
    ...overrides,
  } as unknown as AgentActivityEntry;
}

describe('OtlpTraceFlusher - plan 2.1/2.2 (zcode TTL + debounce)', () => {
  let flusher: OtlpTraceFlusher;

  afterEach(async () => {
    if (flusher) await flusher.shutdown();
  });

  it('debounce=0 (default): Signal A triggers immediate flush, late entry dropped', async () => {
    const { convertEventLogToTrace } = await import('@loongsuite/otel-util-genai');
    const mockConvert = vi.mocked(convertEventLogToTrace);
    mockConvert.mockClear();

    flusher = new OtlpTraceFlusher(makeConfig() as any);
    // send llm.request + llm.response(stop) → Signal A triggers flush
    await flusher.send(makeZcodeEntry({ 'event.name': 'llm.request' }));
    await flusher.send(makeZcodeEntry({
      'gen_ai.response.finish_reasons': ['stop'],
    }));
    expect(mockConvert).toHaveBeenCalledTimes(1);
    expect(mockConvert.mock.calls[0][0]).toHaveLength(2);

    // Late entry (post-flush) should be dropped (no second conversion)
    mockConvert.mockClear();
    await flusher.send(makeZcodeEntry({ 'event.name': 'tool.call' }));
    expect(mockConvert).not.toHaveBeenCalled();
  });

  it('debounce=200ms (per-agent zcode): late entry within window merged into same flush', async () => {
    const { convertEventLogToTrace } = await import('@loongsuite/otel-util-genai');
    const mockConvert = vi.mocked(convertEventLogToTrace);
    mockConvert.mockClear();

    flusher = new OtlpTraceFlusher(makeConfig({
      perAgentFlusherConfig: {
        zcode: { turnFlushDebounceMs: 200 },
      },
    }) as any);

    await flusher.send(makeZcodeEntry({ 'event.name': 'llm.request' }));
    await flusher.send(makeZcodeEntry({
      'gen_ai.response.finish_reasons': ['stop'],
    }));

    // Debounce active — flush not yet fired
    expect(mockConvert).not.toHaveBeenCalled();

    // Late hook tool.call arrives within 200ms — should be merged
    await flusher.send(makeZcodeEntry({ 'event.name': 'tool.call' }));

    // Wait for debounce to fire (200ms + slack)
    await new Promise((r) => setTimeout(r, 350));

    expect(mockConvert).toHaveBeenCalledTimes(1);
    const records = mockConvert.mock.calls[0][0];
    expect(records).toHaveLength(3); // llm.request + llm.response + tool.call
  });

  it('debounce=200ms: late entry AFTER window is dropped', async () => {
    const { convertEventLogToTrace } = await import('@loongsuite/otel-util-genai');
    const mockConvert = vi.mocked(convertEventLogToTrace);
    mockConvert.mockClear();

    flusher = new OtlpTraceFlusher(makeConfig({
      perAgentFlusherConfig: {
        zcode: { turnFlushDebounceMs: 200 },
      },
    }) as any);

    await flusher.send(makeZcodeEntry({ 'event.name': 'llm.request' }));
    await flusher.send(makeZcodeEntry({
      'gen_ai.response.finish_reasons': ['stop'],
    }));

    // Wait for debounce to fire
    await new Promise((r) => setTimeout(r, 350));
    expect(mockConvert).toHaveBeenCalledTimes(1);
    expect(mockConvert.mock.calls[0][0]).toHaveLength(2);

    // Late entry after debounce window — dropped
    mockConvert.mockClear();
    await flusher.send(makeZcodeEntry({ 'event.name': 'tool.call' }));
    await new Promise((r) => setTimeout(r, 100));
    expect(mockConvert).not.toHaveBeenCalled();
  });

  it('turnIdleTimeoutMs (per-agent): cmdStop 缺失 → idle 超时强制 flush', async () => {
    const { convertEventLogToTrace } = await import('@loongsuite/otel-util-genai');
    const mockConvert = vi.mocked(convertEventLogToTrace);
    mockConvert.mockClear();

    // Use a small TTL (100ms) for test speed; production zcode uses 120000ms.
    flusher = new OtlpTraceFlusher(makeConfig({
      perAgentFlusherConfig: {
        zcode: { turnIdleTimeoutMs: 100 },
      },
    }) as any);

    // send llm.request only — no stop signal (cmdStop missing)
    await flusher.send(makeZcodeEntry({ 'event.name': 'llm.request' }));
    expect(mockConvert).not.toHaveBeenCalled();

    // Wait past idle timeout (100ms) + slack for 1s tick interval
    // (tickIdleTimeout runs every 1s; first tick that sees now-lastActivity>=100
    // fires within ~1s).
    await new Promise((r) => setTimeout(r, 1500));

    expect(mockConvert).toHaveBeenCalledTimes(1);
    expect(mockConvert.mock.calls[0][0]).toHaveLength(1);
  });

  // P0 race condition fix: rollout input's terminal llm.response (with
  // agent.source='zcode-rollout') must NOT trigger Signal A flush. Rollout
  // polls every 30s; when it reads the final record, hook JSONL's tool events
  // may not have been polled yet by zcode-log input (5s poll). If Signal A
  // fires here, the debounce window starts, and hook events arriving after
  // the window get dropped by the late-arrival guard.
  //
  // Fix: rollout's terminal llm.response is suppressed in send() when
  // agent.source === 'zcode-rollout'. Stop hook's terminal finish_reason
  // (end_turn) is the canonical Signal A trigger, fires after all hook events
  // are in JSONL. turnFlushDebounceMs (35s > 30s rollout poll) gives rollout
  // input time to dispatch records before the window closes.
  it('P0 fix: rollout terminal (agent.source=zcode-rollout) suppressed; Stop end_turn triggers flush with all events merged', async () => {
    const { convertEventLogToTrace } = await import('@loongsuite/otel-util-genai');
    const mockConvert = vi.mocked(convertEventLogToTrace);
    mockConvert.mockClear();

    flusher = new OtlpTraceFlusher(makeConfig({
      perAgentFlusherConfig: { zcode: { turnFlushDebounceMs: 200 } },
    }) as any);

    // Rollout's terminal llm.response — agent.source=zcode-rollout suppresses Signal A
    await flusher.sendBatch([
      makeZcodeEntry({ 'event.name': 'llm.request', 'gen_ai.request.id': 'req1', 'agent.source': 'zcode-rollout' }),
      makeZcodeEntry({ 'event.name': 'llm.response', 'gen_ai.request.id': 'req1', 'gen_ai.response.finish_reasons': ['stop'], 'agent.source': 'zcode-rollout' }),
    ]);
    // No flush scheduled — buffer still active, not completed
    expect(mockConvert).not.toHaveBeenCalled();
    expect((flusher as any).flushDebounceTimers.size).toBe(0);

    // Hook Stop event arrives (no agent.source = hook side) — triggers Signal A
    await flusher.send(makeZcodeEntry({
      'event.name': 'other',
      'gen_ai.agent.event.name': 'stop',
      'gen_ai.response.finish_reasons': ['end_turn'],
    }));
    // Debounce timer scheduled, no immediate flush
    expect(mockConvert).not.toHaveBeenCalled();
    expect((flusher as any).flushDebounceTimers.size).toBe(1);

    // Late hook tool.call arrives within debounce window — merged
    await flusher.send(makeZcodeEntry({ 'event.name': 'tool.call' }));

    // Wait for debounce to fire (200ms + slack)
    await new Promise((r) => setTimeout(r, 350));

    expect(mockConvert).toHaveBeenCalledTimes(1);
    const records = mockConvert.mock.calls[0][0];
    // llm.request + llm.response (rollout) + Stop other (hook) + tool.call (hook) = 4
    expect(records).toHaveLength(4);
  });

  it('P0 fix: rollout terminal suppressed — if Stop never fires, idle timeout flushes', async () => {
    const { convertEventLogToTrace } = await import('@loongsuite/otel-util-genai');
    const mockConvert = vi.mocked(convertEventLogToTrace);
    mockConvert.mockClear();

    flusher = new OtlpTraceFlusher(makeConfig({
      perAgentFlusherConfig: { zcode: { turnIdleTimeoutMs: 100 } },
    }) as any);

    // Rollout terminal — suppressed, buffer stays not-completed
    await flusher.sendBatch([
      makeZcodeEntry({ 'event.name': 'llm.request', 'agent.source': 'zcode-rollout' }),
      makeZcodeEntry({ 'gen_ai.response.finish_reasons': ['stop'], 'agent.source': 'zcode-rollout' }),
    ]);
    expect(mockConvert).not.toHaveBeenCalled();

    // No Stop event — wait for idle timeout (100ms + ~1s tick)
    await new Promise((r) => setTimeout(r, 1500));

    expect(mockConvert).toHaveBeenCalledTimes(1);
    expect(mockConvert.mock.calls[0][0]).toHaveLength(2);
  });
  // AGE-675: sendBatch 路径走 triggerFlush (per-agent debounce).
  // P0 回归护栏: flush()/shutdown 路径必须立即 flush, 不能让 debounce timer
  // 在 exporter shutdown 后才 fire (zcode turn 数据丢失).
  it('debounce=200: sendBatch triggers terminal then flush() -> immediate flush, no pending timer', async () => {
    const { convertEventLogToTrace } = await import('@loongsuite/otel-util-genai');
    const mockConvert = vi.mocked(convertEventLogToTrace);
    mockConvert.mockClear();

    flusher = new OtlpTraceFlusher(makeConfig({
      perAgentFlusherConfig: { zcode: { turnFlushDebounceMs: 200 } },
    }) as any);

    await flusher.sendBatch([
      makeZcodeEntry({ 'event.name': 'llm.request' }),
      makeZcodeEntry({ 'gen_ai.response.finish_reasons': ['stop'] }),
    ]);
    expect(mockConvert).not.toHaveBeenCalled();

    await flusher.flush();

    expect(mockConvert).toHaveBeenCalledTimes(1);
    expect(mockConvert.mock.calls[0][0]).toHaveLength(2);
    expect((flusher as any).flushDebounceTimers.size).toBe(0);
  });

  it('debounce=0 (default): sendBatch cross-batch -> second batch dropped by late-arrival guard', async () => {
    const { convertEventLogToTrace } = await import('@loongsuite/otel-util-genai');
    const mockConvert = vi.mocked(convertEventLogToTrace);
    mockConvert.mockClear();

    flusher = new OtlpTraceFlusher(makeConfig() as any);

    await flusher.sendBatch([
      makeZcodeEntry({ 'event.name': 'llm.request' }),
      makeZcodeEntry({ 'event.name': 'llm.response', 'gen_ai.response.finish_reasons': ['stop'] }),
    ]);
    expect(mockConvert).toHaveBeenCalledTimes(1);
    expect(mockConvert.mock.calls[0][0]).toHaveLength(2);

    mockConvert.mockClear();
    await flusher.sendBatch([
      makeZcodeEntry({ 'event.name': 'tool.call' }),
      makeZcodeEntry({ 'event.name': 'tool.result' }),
    ]);
    expect(mockConvert).not.toHaveBeenCalled();
  });

  it('debounce=200: sendBatch cross-batch timing -> second batch appended within window -> merged flush', async () => {
    const { convertEventLogToTrace } = await import('@loongsuite/otel-util-genai');
    const mockConvert = vi.mocked(convertEventLogToTrace);
    mockConvert.mockClear();

    flusher = new OtlpTraceFlusher(makeConfig({
      perAgentFlusherConfig: { zcode: { turnFlushDebounceMs: 200 } },
    }) as any);

    await flusher.sendBatch([
      makeZcodeEntry({ 'event.name': 'llm.request' }),
      makeZcodeEntry({ 'event.name': 'llm.response', 'gen_ai.response.finish_reasons': ['stop'] }),
    ]);
    expect(mockConvert).not.toHaveBeenCalled();

    await new Promise((r) => setTimeout(r, 12));
    await flusher.sendBatch([
      makeZcodeEntry({ 'event.name': 'tool.call' }),
      makeZcodeEntry({ 'event.name': 'tool.result' }),
    ]);

    await new Promise((r) => setTimeout(r, 350));

    expect(mockConvert).toHaveBeenCalledTimes(1);
    expect(mockConvert.mock.calls[0][0]).toHaveLength(4);
  });
});
