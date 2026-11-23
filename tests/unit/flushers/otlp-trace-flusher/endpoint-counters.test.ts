import { describe, it, expect, vi } from 'vitest';

vi.mock('@loongsuite/otel-util-genai', () => ({
  convertEventLogToTrace: vi.fn(() => ({ traceIds: [], spanCount: 0, warnings: [] })),
  ExtendedTelemetryHandler: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@opentelemetry/exporter-trace-otlp-proto', () => ({
  OTLPTraceExporter: vi.fn().mockImplementation(() => ({
    export: vi.fn((_s: unknown, cb: (r: { code: number }) => void) => cb({ code: 0 })),
    shutdown: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';

const CMS_ENDPOINT =
  'https://proj-xtrace-1d3dc285e44fcb12fa8cbcb1dd13551-cn-hongkong.cn-hongkong.log.aliyuncs.com/apm/trace/opentelemetry';

function counters(endpoints: Array<{ name: string; endpoint: string; headers?: Record<string, string> }>) {
  const flusher = new OtlpTraceFlusher({
    enabled: true,
    endpoints,
    protocol: 'http/protobuf',
    serviceName: 'test',
  });
  return flusher.getEndpointCounters();
}

describe('OtlpTraceFlusher - endpoint counter identity', () => {
  it('reports an ARMS destination on the same project/logstore axis as SLS', () => {
    // x-arms-project is what config-loader already derived from the endpoint host;
    // the counter must reuse it rather than parse the URL a second time.
    const counter = counters([{
      name: 'user-cms',
      endpoint: CMS_ENDPOINT,
      headers: {
        'x-arms-license-key': 'lk',
        'x-arms-project': 'proj-xtrace-1d3dc285e44fcb12fa8cbcb1dd13551-cn-hongkong',
      },
    }]).get('user-cms')!;

    expect(counter.isCms).toBe(true);
    expect(counter.project).toBe('proj-xtrace-1d3dc285e44fcb12fa8cbcb1dd13551-cn-hongkong');
    expect(counter.logstore).toBe('logstore-tracing');
  });

  it('falls back to the endpoint host when only the workspace header marks it as CMS', () => {
    const counter = counters([{
      name: 'inner-cms-0',
      endpoint: CMS_ENDPOINT,
      headers: { 'X-CMS-Workspace': 'ws-1' },
    }]).get('inner-cms-0')!;

    expect(counter.isCms).toBe(true);
    expect(counter.project).toBe('proj-xtrace-1d3dc285e44fcb12fa8cbcb1dd13551-cn-hongkong');
    expect(counter.logstore).toBe('logstore-tracing');
  });

  it('leaves project/logstore empty for a plain OTLP backend', () => {
    // Not our storage to name: a generic collector has no SLS project behind it.
    const counter = counters([{
      name: 'user-otlp',
      endpoint: 'https://collector.example.com/v1/traces',
      headers: { authorization: 'Bearer t' },
    }]).get('user-otlp')!;

    expect(counter.isCms).toBe(false);
    expect(counter.project).toBe('');
    expect(counter.logstore).toBe('');
  });
});
