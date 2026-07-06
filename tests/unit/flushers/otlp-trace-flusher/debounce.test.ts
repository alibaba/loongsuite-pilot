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

  // CP5 fix: Stop hook "other" event 不带 terminal finish_reason。
  // 场景: ZCode 退出时 Stop hook 立即触发 "other" 事件,但 rollout 记录要等
  // 下一轮 poll (30s) 才能读到。若 Stop 带 end_turn,会立即 flush 只含
  // hook 工具事件的 buffer,之后 rollout 的 llm.request/response 全被
  // late-arrival guard 丢弃。修复后 Stop 不带 finish_reason,buffer 保持
  // not-completed,等 rollout 的最后一条 llm.response(stop) 触发真正 flush。
  it('Stop "other" 不带 finish_reason: 不触发 flush,等 rollout llm.response(stop) 一起 flush', async () => {
    const { convertEventLogToTrace } = await import('@loongsuite/otel-util-genai');
    const mockConvert = vi.mocked(convertEventLogToTrace);
    mockConvert.mockClear();

    flusher = new OtlpTraceFlusher(makeConfig() as any);

    // Stop hook 的 "other" 事件 (无 finish_reason) — 不应触发 flush
    await flusher.send(makeZcodeEntry({
      'event.name': 'other',
      'gen_ai.agent.event.name': 'stop',
    }));
    expect(mockConvert).not.toHaveBeenCalled();

    // 之后 rollout 的 llm.request/response 到达 — 最后一条带 stop 触发 flush
    await flusher.sendBatch([
      makeZcodeEntry({ 'event.name': 'llm.request', 'gen_ai.request.id': 'req1' }),
      makeZcodeEntry({ 'event.name': 'llm.response', 'gen_ai.request.id': 'req1', 'gen_ai.response.finish_reasons': ['stop'] }),
    ]);
    expect(mockConvert).toHaveBeenCalledTimes(1);
    // buffer 应包含 Stop "other" + llm.request + llm.response = 3 条
    expect(mockConvert.mock.calls[0][0]).toHaveLength(3);
  });
});
