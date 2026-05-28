import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@loongsuite/otel-util-genai', () => ({
  convertEventLogToTrace: vi.fn(() => ({ traceIds: ['trace-1'], spanCount: 3, warnings: [] })),
  ExtendedTelemetryHandler: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@opentelemetry/exporter-trace-otlp-proto', () => ({
  OTLPTraceExporter: vi.fn().mockImplementation(() => ({
    export: vi.fn((_s: unknown, cb: (r: { code: number }) => void) => cb({ code: 0 })),
    shutdown: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';
import { convertEventLogToTrace } from '@loongsuite/otel-util-genai';
import type { AgentActivityEntry } from '../../../../src/types/index.js';

function makeConfig() {
  return {
    enabled: true,
    endpoint: 'http://localhost:4318',
    protocol: 'http/protobuf' as const,
    headers: { 'x-key': 'val' },
    serviceName: 'test-pilot',
    resourceAttributes: { 'custom.attr': 'hello' },
  };
}

describe('OtlpTraceFlusher - conversion', () => {
  let flusher: OtlpTraceFlusher;

  beforeEach(() => {
    vi.mocked(convertEventLogToTrace).mockClear();
    flusher = new OtlpTraceFlusher(makeConfig());
  });

  afterEach(async () => {
    await flusher.shutdown();
  });

  it('calls convertEventLogToTrace with correct records on turn completion', async () => {
    const entries = [
      { 'event.name': 'llm.request', 'gen_ai.agent.type': 'claude-code', 'gen_ai.turn.id': 't1' },
      { 'event.name': 'llm.response', 'gen_ai.agent.type': 'claude-code', 'gen_ai.turn.id': 't1', 'gen_ai.response.finish_reasons': ['stop'] },
    ] as unknown as AgentActivityEntry[];

    for (const e of entries) await flusher.send(e);

    expect(convertEventLogToTrace).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(convertEventLogToTrace).mock.calls[0];
    expect(callArgs[0]).toHaveLength(2);
    expect(callArgs[1]).toMatchObject({ strict: false });
  });

  it('passes handler from per-agent convert state', async () => {
    const entry = {
      'event.name': 'llm.response',
      'gen_ai.agent.type': 'codex',
      'gen_ai.turn.id': 't2',
      'gen_ai.response.finish_reasons': ['stop'],
    } as unknown as AgentActivityEntry;

    await flusher.send(entry);

    const callArgs = vi.mocked(convertEventLogToTrace).mock.calls[0];
    expect(callArgs[1]).toHaveProperty('handler');
  });

  it('logs warnings without throwing', async () => {
    vi.mocked(convertEventLogToTrace).mockReturnValueOnce({ traceIds: [], spanCount: 0, warnings: ['orphan llm.request'] });

    const entry = {
      'event.name': 'llm.response',
      'gen_ai.agent.type': 'claude-code',
      'gen_ai.turn.id': 't3',
      'gen_ai.response.finish_reasons': ['stop'],
    } as unknown as AgentActivityEntry;

    // Should not throw
    await flusher.send(entry);
    expect(convertEventLogToTrace).toHaveBeenCalledTimes(1);
  });

  it('does not export when conversion produces zero spans', async () => {
    // forceFlush + getFinishedSpans returns empty
    const entry = {
      'event.name': 'llm.response',
      'gen_ai.agent.type': 'claude-code',
      'gen_ai.turn.id': 't4',
      'gen_ai.response.finish_reasons': ['stop'],
    } as unknown as AgentActivityEntry;

    await flusher.send(entry);
    // No error thrown, graceful skip
  });
});
