import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

vi.mock('@loongsuite/otel-util-genai', () => ({
  convertEventLogToTrace: vi.fn(() => ({ traceIds: ['trace-1'], spanCount: 1, warnings: [] })),
  ExtendedTelemetryHandler: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@opentelemetry/exporter-trace-otlp-proto', () => ({
  OTLPTraceExporter: vi.fn().mockImplementation(() => ({
    export: vi.fn((_spans: unknown, cb: (result: { code: number }) => void) => cb({ code: 0 })),
    shutdown: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { InputManager } from '../../../src/core/input-manager.js';
import { OtlpTraceFlusher } from '../../../src/flushers/otlp-trace-flusher.js';
import { ClientType, CollectionMethod } from '../../../src/types/index.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { convertEventLogToTrace } from '@loongsuite/otel-util-genai';
import { buildTestEntry } from '../../helpers/fixture-builder.js';

class StubInput extends EventEmitter {
  readonly id = 'codex-log';
  readonly agentType = ClientType.Codex;
  readonly collectionMethod = CollectionMethod.LocalLogTail;
  readonly running = true;
  async start() {}
  async stop() {}
}

function makeTraceConfig() {
  return {
    enabled: true,
    endpoint: 'http://localhost:4318',
    protocol: 'http/protobuf' as const,
    headers: { 'x-key': 'val' },
    serviceName: 'test-pilot',
  };
}

describe('InputManager collector mask with OTLP trace flusher', () => {
  let manager: InputManager;
  let flusher: OtlpTraceFlusher;

  beforeEach(() => {
    vi.mocked(convertEventLogToTrace).mockClear();
    manager = new InputManager();
    flusher = new OtlpTraceFlusher(makeTraceConfig());
    manager.setFlusher(flusher);
    manager.setMaskConfig({ mode: 'all', types: [] });
  });

  afterEach(async () => {
    await flusher.shutdown();
  });

  it('passes masked records into convertEventLogToTrace', async () => {
    const input = new StubInput();
    manager.registerInput(input as any);

    const apiKey = 'sk-1234567890abcdefghijklmnop';
    const entry = buildTestEntry({
      agentType: ClientType.Codex,
      'event.name': 'llm.response',
      'gen_ai.turn.id': 'turn-1',
      'gen_ai.response.finish_reasons': ['stop'],
      'gen_ai.input.messages': [{ role: 'user', content: `use ${apiKey}` }],
    }) as AgentActivityEntry;

    input.emit('entries', [entry]);
    await new Promise(r => setTimeout(r, 50));

    expect(convertEventLogToTrace).toHaveBeenCalledTimes(1);
    const records = vi.mocked(convertEventLogToTrace).mock.calls[0][0];
    expect(JSON.stringify(records)).toContain('[APIKEY_MASKED]');
    expect(JSON.stringify(records)).not.toContain(apiKey);
  });
});
