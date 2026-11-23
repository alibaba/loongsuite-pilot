import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@loongsuite/otel-util-genai', () => ({
  convertEventLogToTrace: vi.fn(() => ({ traceIds: [], spanCount: 0, warnings: [] })),
  ExtendedTelemetryHandler: vi.fn().mockImplementation(() => ({})),
}));

const mockShutdown = vi.fn().mockResolvedValue(undefined);
const mockExport = vi.fn((_s: unknown, cb: (r: { code: number }) => void) => cb({ code: 0 }));

vi.mock('@opentelemetry/exporter-trace-otlp-proto', () => ({
  OTLPTraceExporter: vi.fn().mockImplementation(() => ({
    export: mockExport,
    shutdown: mockShutdown,
  })),
}));

import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';

function makeConfig() {
  return {
    enabled: true,
    endpoints: [{ name: 'primary', endpoint: 'http://localhost:4318', headers: { 'x-key': 'val' } }],
    protocol: 'http/protobuf' as const,
    serviceName: 'test-pilot',
  };
}

describe('OtlpTraceFlusher - lifecycle', () => {
  afterEach(() => {
    mockShutdown.mockClear();
    mockExport.mockClear();
  });

  it('shutdown drains pending turn buffers', async () => {
    const { convertEventLogToTrace } = await import('@loongsuite/otel-util-genai');
    const mockConvert = vi.mocked(convertEventLogToTrace);
    mockConvert.mockClear();

    const flusher = new OtlpTraceFlusher(makeConfig());

    // Add entries without completing the turn
    await flusher.send({
      'event.name': 'llm.request',
      'gen_ai.agent.type': 'claude-code',
      'gen_ai.turn.id': 'pending-turn',
    } as unknown as AgentActivityEntry);

    expect(mockConvert).not.toHaveBeenCalled();

    await flusher.shutdown();

    // Shutdown should have force-completed and converted the pending turn
    expect(mockConvert).toHaveBeenCalledTimes(1);
  });

  it('shutdown calls exporter.shutdown on all per-agent exporters', async () => {
    const flusher = new OtlpTraceFlusher(makeConfig());

    // Create exporters for two agent types via test seam
    await flusher.exportSpansForAgent('claude-code', []);
    await flusher.exportSpansForAgent('codex', []);

    await flusher.shutdown();

    // Each agent type's exporter should be shut down
    expect(mockShutdown).toHaveBeenCalledTimes(2);
  });

  it('exportSpansForAgent test seam bypasses turn buffer and converter', async () => {
    const { convertEventLogToTrace } = await import('@loongsuite/otel-util-genai');
    const mockConvert = vi.mocked(convertEventLogToTrace);
    mockConvert.mockClear();

    const flusher = new OtlpTraceFlusher(makeConfig());

    const mockSpan = {
      spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }),
      parentSpanId: undefined,
      name: 'direct-span',
      kind: 0,
      startTime: [1000, 0] as [number, number],
      endTime: [1001, 0] as [number, number],
      attributes: {},
      status: { code: 0 },
      resource: { attributes: {} },
    } as any;

    await flusher.exportSpansForAgent('claude-code', [mockSpan]);
    await flusher.shutdown();

    // convertEventLogToTrace should NOT be called (bypassed)
    expect(mockConvert).not.toHaveBeenCalled();
    // But export should have been called
    expect(mockExport).toHaveBeenCalledTimes(1);
  });

  it('idle timeout flushes stale buffers when configured', async () => {
    const { convertEventLogToTrace } = await import('@loongsuite/otel-util-genai');
    const mockConvert = vi.mocked(convertEventLogToTrace);
    mockConvert.mockClear();

    const flusher = new OtlpTraceFlusher({
      ...makeConfig(),
      turnIdleTimeoutMs: 100, // very short for testing
    });

    await flusher.send({
      'event.name': 'llm.request',
      'gen_ai.agent.type': 'claude-code',
      'gen_ai.turn.id': 'idle-turn',
    } as unknown as AgentActivityEntry);

    expect(mockConvert).not.toHaveBeenCalled();

    // Wait for idle timeout + tick interval to fire
    await new Promise((r) => setTimeout(r, 1200));

    expect(mockConvert).toHaveBeenCalledTimes(1);

    await flusher.shutdown();
  });
});
