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
    'gen_ai.agent.type': 'claude-code',
    'trace_id': '4bf92f3577b34da6a3ce929d0e0e4736',
    ...overrides,
  } as unknown as AgentActivityEntry;
}

describe('OtlpTraceFlusher - turn boundary detection', () => {
  let flusher: OtlpTraceFlusher;

  beforeEach(() => {
    flusher = new OtlpTraceFlusher(makeConfig());
  });

  afterEach(async () => {
    await flusher.shutdown();
  });

  it('Signal A: finish_reason=stop triggers immediate flush', async () => {
    const { convertEventLogToTrace } = await import('@loongsuite/otel-util-genai');
    const mockConvert = vi.mocked(convertEventLogToTrace);
    mockConvert.mockClear();

    await flusher.send(makeEntry({ 'event.name': 'llm.request' }));
    expect(mockConvert).not.toHaveBeenCalled();

    await flusher.send(makeEntry({
      'gen_ai.response.finish_reasons': ['stop'],
    }));
    // Should have been called (turn completed by Signal A)
    expect(mockConvert).toHaveBeenCalledTimes(1);
    const records = mockConvert.mock.calls[0][0];
    expect(records).toHaveLength(2);
  });

  it('Signal A: finish_reason=tool_calls does NOT end turn', async () => {
    const { convertEventLogToTrace } = await import('@loongsuite/otel-util-genai');
    const mockConvert = vi.mocked(convertEventLogToTrace);
    mockConvert.mockClear();

    await flusher.send(makeEntry({
      'gen_ai.response.finish_reasons': ['tool_calls'],
    }));
    // Should NOT trigger conversion
    expect(mockConvert).not.toHaveBeenCalled();
  });

  it('Signal B: new groupKey triggers flush of old buffer', async () => {
    const { convertEventLogToTrace } = await import('@loongsuite/otel-util-genai');
    const mockConvert = vi.mocked(convertEventLogToTrace);
    mockConvert.mockClear();

    // First turn
    await flusher.send(makeEntry({
      'trace_id': 'aaaa2f3577b34da6a3ce929d0e0e4736',
    }));
    expect(mockConvert).not.toHaveBeenCalled();

    // New trace_id → old turn should flush
    await flusher.send(makeEntry({
      'trace_id': 'bbbb2f3577b34da6a3ce929d0e0e4736',
    }));
    expect(mockConvert).toHaveBeenCalledTimes(1);
    const records = mockConvert.mock.calls[0][0];
    expect(records).toHaveLength(1);
  });

  it('Signal C: shutdown drains all pending buffers', async () => {
    const { convertEventLogToTrace } = await import('@loongsuite/otel-util-genai');
    const mockConvert = vi.mocked(convertEventLogToTrace);
    mockConvert.mockClear();

    await flusher.send(makeEntry());
    await flusher.send(makeEntry());
    expect(mockConvert).not.toHaveBeenCalled();

    await flusher.shutdown();
    expect(mockConvert).toHaveBeenCalledTimes(1);
    expect(mockConvert.mock.calls[0][0]).toHaveLength(2);
  });

  it('backfills gen_ai.turn.id when using trace_id as group key', async () => {
    const { convertEventLogToTrace } = await import('@loongsuite/otel-util-genai');
    const mockConvert = vi.mocked(convertEventLogToTrace);
    mockConvert.mockClear();

    const traceId = 'aaaa2f3577b34da6a3ce929d0e0e4736';
    await flusher.send(makeEntry({ 'trace_id': traceId }));
    await flusher.send(makeEntry({
      'trace_id': traceId,
      'gen_ai.response.finish_reasons': ['stop'],
    }));

    const records = mockConvert.mock.calls[0][0] as Record<string, unknown>[];
    for (const r of records) {
      expect(r['gen_ai.turn.id']).toBe(traceId);
    }
  });

  describe('sendBatch — regression vs master sequential send()', () => {
    it('Codex-like step: tool_call response then tools in same batch does not early-flush', async () => {
      const { convertEventLogToTrace } = await import('@loongsuite/otel-util-genai');
      const mockConvert = vi.mocked(convertEventLogToTrace);
      mockConvert.mockClear();

      const turnId = 'session-1:t1';
      const base = {
        'gen_ai.turn.id': turnId,
        'gen_ai.agent.type': 'codex',
        'trace_id': '4bf92f3577b34da6a3ce929d0e0e4736',
      };

      // Per-step order from codex-hook-processor: llm.response(tool_call) → tool.call → tool.result
      await flusher.sendBatch([
        makeEntry({ ...base, 'event.name': 'llm.request', 'gen_ai.step.id': `${turnId}:s1` }),
        makeEntry({
          ...base,
          'event.name': 'llm.response',
          'gen_ai.step.id': `${turnId}:s1`,
          'gen_ai.response.finish_reasons': ['tool_call'],
        }),
        makeEntry({ ...base, 'event.name': 'tool.call', 'gen_ai.step.id': `${turnId}:s1` }),
        makeEntry({ ...base, 'event.name': 'tool.result', 'gen_ai.step.id': `${turnId}:s1` }),
        makeEntry({
          ...base,
          'event.name': 'llm.response',
          'gen_ai.step.id': `${turnId}:s2`,
          'gen_ai.response.finish_reasons': ['stop'],
        }),
      ]);

      expect(mockConvert).toHaveBeenCalledTimes(1);
      expect(mockConvert.mock.calls[0][0]).toHaveLength(5);
    });

    it('Claude-like batch: tools sorted before stop are all included in one flush', async () => {
      const { convertEventLogToTrace } = await import('@loongsuite/otel-util-genai');
      const mockConvert = vi.mocked(convertEventLogToTrace);
      mockConvert.mockClear();

      const turnId = 'session-1:t1';
      const base = {
        'gen_ai.turn.id': turnId,
        'gen_ai.agent.type': 'claude-code',
        'trace_id': '4bf92f3577b34da6a3ce929d0e0e4736',
      };

      // claude-code-hook-processor sorts by time_unix_nano so tools precede stop
      await flusher.sendBatch([
        makeEntry({ ...base, 'event.name': 'llm.request' }),
        makeEntry({ ...base, 'event.name': 'tool.call' }),
        makeEntry({ ...base, 'event.name': 'tool.result' }),
        makeEntry({
          ...base,
          'event.name': 'llm.response',
          'gen_ai.response.finish_reasons': ['stop'],
        }),
      ]);

      expect(mockConvert).toHaveBeenCalledTimes(1);
      expect(mockConvert.mock.calls[0][0]).toHaveLength(4);
    });

    it('Cursor-like batch: records after stop in same batch are kept (differs from master send loop)', async () => {
      const { convertEventLogToTrace } = await import('@loongsuite/otel-util-genai');
      const mockConvert = vi.mocked(convertEventLogToTrace);
      mockConvert.mockClear();

      const turnId = 'gen-abc';
      const base = {
        'gen_ai.turn.id': turnId,
        'gen_ai.agent.type': 'cursor',
        'trace_id': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      };

      await flusher.sendBatch([
        makeEntry({ ...base, 'event.name': 'llm.request' }),
        makeEntry({
          ...base,
          'event.name': 'llm.response',
          'gen_ai.response.finish_reasons': ['stop'],
        }),
        makeEntry({
          ...base,
          'event.name': 'llm.request',
          'gen_ai.agent.scope': 'subagent',
          'gen_ai.subagent.parent_tool_call.id': 'call-sub',
        }),
        makeEntry({
          ...base,
          'event.name': 'llm.response',
          'gen_ai.agent.scope': 'subagent',
          'gen_ai.subagent.parent_tool_call.id': 'call-sub',
          'gen_ai.response.finish_reasons': ['stop'],
        }),
      ]);

      expect(mockConvert).toHaveBeenCalledTimes(1);
      expect(mockConvert.mock.calls[0][0]).toHaveLength(4);
    });

    it('multi-turn batch: each completed turn flushes once at batch end', async () => {
      const { convertEventLogToTrace } = await import('@loongsuite/otel-util-genai');
      const mockConvert = vi.mocked(convertEventLogToTrace);
      mockConvert.mockClear();

      await flusher.sendBatch([
        makeEntry({
          'gen_ai.turn.id': 'session:t1',
          'gen_ai.agent.type': 'codex',
          'event.name': 'llm.response',
          'gen_ai.response.finish_reasons': ['stop'],
        }),
        makeEntry({
          'gen_ai.turn.id': 'session:t2',
          'gen_ai.agent.type': 'codex',
          'event.name': 'llm.request',
        }),
        makeEntry({
          'gen_ai.turn.id': 'session:t2',
          'gen_ai.agent.type': 'codex',
          'event.name': 'llm.response',
          'gen_ai.response.finish_reasons': ['stop'],
        }),
      ]);
      // sendBatch defers triggerFlush; wait for in-flight exports before asserting
      await flusher.flush();

      expect(mockConvert).toHaveBeenCalledTimes(2);
      expect(mockConvert.mock.calls[0][0]).toHaveLength(1);
      expect(mockConvert.mock.calls[1][0]).toHaveLength(2);
    });

    it('cross-batch late entries after stop are still dropped (dual-root guard unchanged)', async () => {
      const { convertEventLogToTrace } = await import('@loongsuite/otel-util-genai');
      const mockConvert = vi.mocked(convertEventLogToTrace);
      mockConvert.mockClear();

      const turnId = 'session-1:t1';
      const base = {
        'gen_ai.turn.id': turnId,
        'gen_ai.agent.type': 'claude-code',
      };

      await flusher.sendBatch([
        makeEntry({ ...base, 'event.name': 'llm.request' }),
        makeEntry({
          ...base,
          'event.name': 'llm.response',
          'gen_ai.response.finish_reasons': ['stop'],
        }),
      ]);
      expect(mockConvert).toHaveBeenCalledTimes(1);

      await flusher.sendBatch([
        makeEntry({ ...base, 'event.name': 'tool.call' }),
      ]);

      expect(mockConvert).toHaveBeenCalledTimes(1);
    });
  });

  it('drops late entries for already-flushed turns (prevents dual-root)', async () => {
    const { convertEventLogToTrace } = await import('@loongsuite/otel-util-genai');
    const mockConvert = vi.mocked(convertEventLogToTrace);
    mockConvert.mockClear();

    const turnId = 'session-1:t1';

    // Entry 1: llm.request
    await flusher.send(makeEntry({
      'gen_ai.turn.id': turnId,
      'event.name': 'llm.request',
    }));

    // Entry 2: llm.response with stop → triggers Signal A flush
    await flusher.send(makeEntry({
      'gen_ai.turn.id': turnId,
      'event.name': 'llm.response',
      'gen_ai.response.finish_reasons': ['stop'],
    }));

    expect(mockConvert).toHaveBeenCalledTimes(1);
    expect(mockConvert.mock.calls[0][0]).toHaveLength(2);

    // Entry 3: late tool.call for the SAME turn (arrives after flush)
    await flusher.send(makeEntry({
      'gen_ai.turn.id': turnId,
      'event.name': 'tool.call',
    }));

    // Entry 4: another late tool.call
    await flusher.send(makeEntry({
      'gen_ai.turn.id': turnId,
      'event.name': 'tool.call',
    }));

    // Should NOT trigger a second conversion — late entries are dropped
    expect(mockConvert).toHaveBeenCalledTimes(1);

    await flusher.shutdown();

    // Still only 1 conversion total (shutdown should not flush dropped entries)
    expect(mockConvert).toHaveBeenCalledTimes(1);
  });
});
