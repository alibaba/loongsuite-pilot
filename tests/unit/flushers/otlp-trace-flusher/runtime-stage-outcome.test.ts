import { ExportResultCode } from '@opentelemetry/core';
import { describe, expect, it, vi } from 'vitest';
import { OtlpTraceFlusher, type OtlpExporterFactory } from '../../../../src/flushers/otlp-trace-flusher.js';
import { createRuntimeIdentity } from '../../../../src/metrics/runtime-identity.js';
import {
  TRACE_RUNTIME_SIZE_THRESHOLDS,
  TraceRuntimeObserver,
} from '../../../../src/metrics/trace-runtime-observer.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';

function turn(): AgentActivityEntry[] {
  const now = Date.now() * 1e6;
  const base = {
    trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
    'gen_ai.session.id': 'session-1',
    'gen_ai.turn.id': 'session-1:turn-1',
    'gen_ai.agent.type': 'opencode',
    'gen_ai.provider.name': 'anthropic',
  };
  return [{
    ...base,
    time_unix_nano: String(now),
    'event.id': 'request',
    'event.name': 'llm.request',
    'gen_ai.step.id': 'session-1:turn-1:s1',
    'gen_ai.request.model': 'claude',
  }, {
    ...base,
    time_unix_nano: String(now + 1e6),
    'event.id': 'response',
    'event.name': 'llm.response',
    'gen_ai.step.id': 'session-1:turn-1:s1',
    'gen_ai.request.model': 'claude',
    'gen_ai.response.model': 'claude',
    'gen_ai.response.finish_reasons': ['stop'],
    'gen_ai.usage.input_tokens': 1,
    'gen_ai.usage.output_tokens': 1,
  }] as unknown as AgentActivityEntry[];
}

function observer() {
  return new TraceRuntimeObserver({
    identity: createRuntimeIdentity({
      version: 'test',
      userId: 'user',
      dataDir: '/tmp/trace-runtime-stage-test',
    }),
  });
}

describe('OtlpTraceFlusher Trace runtime stage outcome', () => {
  it('counts converted spans once and one export turn across parallel destinations', async () => {
    const runtime = observer();
    const exported = vi.fn();
    const exporterFactory: OtlpExporterFactory = opts => ({
      export(spans, callback) {
        exported(opts.name, spans.length);
        callback({ code: ExportResultCode.SUCCESS });
      },
      shutdown: async () => undefined,
    });
    const flusher = new OtlpTraceFlusher({
      enabled: true,
      endpoints: [
        { name: 'a', endpoint: 'http://a:4318', headers: {} },
        { name: 'b', endpoint: 'http://b:4318', headers: {} },
      ],
      protocol: 'http/protobuf',
      serviceName: 'test-pilot',
    }, undefined, exporterFactory, runtime);
    const entries = turn();

    await flusher.sendBatch(entries, {
      inputName: 'opencode-log',
      entryLogicalBytes: [TRACE_RUNTIME_SIZE_THRESHOLDS[0], 1],
    });
    await flusher.shutdown();

    expect(exported).toHaveBeenCalledTimes(2);
    const released = runtime.drainDetails().find(record => record.event === 'released');
    expect(released).toMatchObject({
      result: 'success',
      release_reason: 'terminal',
      boundary_signal: 'finish_reason.stop',
    });
    if (released?.event === 'released') {
      expect(released.converted_span_count).toBeGreaterThan(0);
      expect(released.convert_duration_ms).toBeGreaterThanOrEqual(0);
      expect(released.export_duration_ms).toBeGreaterThanOrEqual(0);
      expect(released.rss_before_convert_bytes).toBeGreaterThan(0);
      expect(released.rss_after_convert_bytes).toBeGreaterThan(0);
    }
    const window = runtime.collectWindows()[0];
    expect(window.export_turn_count).toBe(1);
    expect(window.converted_span_count_total).toBe(released?.event === 'released'
      ? released.converted_span_count
      : undefined);
  });

  it('marks the turn export_failed when any destination fails', async () => {
    const runtime = observer();
    const exporterFactory: OtlpExporterFactory = opts => ({
      export(_spans, callback) {
        callback(opts.name === 'bad'
          ? { code: ExportResultCode.FAILED, error: new Error('bad destination') }
          : { code: ExportResultCode.SUCCESS });
      },
      shutdown: async () => undefined,
    });
    const flusher = new OtlpTraceFlusher({
      enabled: true,
      endpoints: [
        { name: 'good', endpoint: 'http://good:4318', headers: {} },
        { name: 'bad', endpoint: 'http://bad:4318', headers: {} },
      ],
      protocol: 'http/protobuf',
      serviceName: 'test-pilot',
    }, undefined, exporterFactory, runtime);
    const entries = turn();

    await flusher.sendBatch(entries, {
      inputName: 'opencode-log',
      entryLogicalBytes: [1, 1],
    });
    await flusher.shutdown();

    expect(runtime.drainDetails()).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'released', result: 'export_failed' }),
    ]));
    expect(runtime.collectWindows()[0].export_failed_turn_count).toBe(1);
  });
});
