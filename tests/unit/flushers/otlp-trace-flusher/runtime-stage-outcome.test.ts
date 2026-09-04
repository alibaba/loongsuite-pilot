import { afterEach, describe, expect, it, vi } from 'vitest';
import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';

const clock = vi.hoisted(() => ({ now: 0, fail: false }));
vi.mock('@loongsuite/otel-util-genai', async importOriginal => {
  const actual = await importOriginal<typeof import('@loongsuite/otel-util-genai')>();
  return {
    ...actual,
    convertEventLogToTrace: (...args: Parameters<typeof actual.convertEventLogToTrace>) => {
      clock.now += 10;
      if (clock.fail) throw new Error('conversion failure');
      return actual.convertEventLogToTrace(...args);
    },
  };
});

function records(): AgentActivityEntry[] {
  const base = {
    trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
    'gen_ai.session.id': 'session', 'gen_ai.turn.id': 'turn',
    'gen_ai.agent.type': 'opencode', 'gen_ai.step.id': 'step',
    'gen_ai.request.model': 'model',
  };
  return [
    { ...base, time_unix_nano: '1780000000000000000', 'event.name': 'llm.request' },
    { ...base, time_unix_nano: '1780000000001000000', 'event.name': 'llm.response', 'gen_ai.response.finish_reasons': ['stop'] },
  ] as unknown as AgentActivityEntry[];
}

const active: OtlpTraceFlusher[] = [];
function setup(services: string[], exported = vi.fn()) {
  vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
  const flusher = new OtlpTraceFlusher({
    enabled: true, protocol: 'http/protobuf', serviceName: 'fallback', appendAgentTypeToServiceName: false,
    endpoints: services.map(serviceName => ({ name: serviceName, serviceName, endpoint: 'http://unused:4318' })),
  }, undefined, opts => ({
    export(spans, callback) { exported(opts.name, spans); callback({ code: 0 }); },
    shutdown: async () => undefined,
  }));
  active.push(flusher);
  return flusher;
}

afterEach(async () => {
  await Promise.all(active.splice(0).map(flusher => flusher.shutdown()));
  vi.restoreAllMocks();
  clock.now = 0;
  clock.fail = false;
});

describe('Trace runtime converter counters', () => {
  it.each([['same', 'same', 1], ['user', 'inner', 2]] as const)(
    'counts actual synchronous conversion calls for %s/%s, without memory samples',
    async (first, second, calls) => {
      const exported = vi.fn();
      const flusher = setup([first, second], exported);
      const memory = vi.spyOn(process, 'memoryUsage');
      await flusher.sendBatch(records(), [100, 200]);
      expect(flusher.getTraceRuntimeSnapshot()[0]).toMatchObject({
        converter_calls_total: calls, converter_duration_ms_total: calls * 10,
        converter_failed_total: 0, removed_buffers_total: 1, pending_buffers: 0,
      });
      expect(exported).toHaveBeenCalledTimes(2);
      expect(memory).not.toHaveBeenCalled();
    },
  );

  it('excludes conversion-lock waiting rather than replacing the sum with a maximum', async () => {
    let unlock!: () => void;
    const flusher = setup(['user', 'inner'], vi.fn(name => {
      if (name === 'user') { clock.now += 500; unlock(); }
    }));
    const internals = flusher as any;
    const input = records();
    const key = internals.buildConvertStateKey('opencode', 'inner', internals.collectResourceAttributes(input));
    internals.convertLocks.set(key, new Promise<void>(resolve => { unlock = resolve; }));
    try {
      await flusher.sendBatch(input, [100, 200]);
      expect(flusher.getTraceRuntimeSnapshot()[0]).toMatchObject({
        converter_calls_total: 2, converter_duration_ms_total: 20,
      });
    } finally { unlock(); }
  });

  it('preserves normal failure handling without a separate diagnostic turn to clean up', async () => {
    const flusher = setup(['single']);
    clock.fail = true;
    await expect(flusher.sendBatch(records(), [100, 200])).resolves.toBeUndefined();
    expect(flusher.getTraceRuntimeSnapshot()[0]).toMatchObject({
      converter_calls_total: 1, converter_duration_ms_total: 10, converter_failed_total: 1,
      removed_logical_bytes_total: 300, pending_buffers: 0,
    });
  });
});
