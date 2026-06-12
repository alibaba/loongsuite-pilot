import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@loongsuite/otel-util-genai', () => ({
  convertEventLogToTrace: vi.fn(() => ({ traceIds: [], spanCount: 0, warnings: [] })),
  ExtendedTelemetryHandler: vi.fn().mockImplementation(() => ({})),
}));

const exportFn = vi.fn((_s: unknown, cb: (r: { code: number }) => void) => cb({ code: 0 }));
const shutdownFn = vi.fn().mockResolvedValue(undefined);

vi.mock('@opentelemetry/exporter-trace-otlp-proto', () => ({
  OTLPTraceExporter: vi.fn().mockImplementation((opts: { url: string }) => {
    (exportFn as any).__url = opts.url;
    return { export: exportFn, shutdown: shutdownFn, __url: opts.url };
  }),
}));

import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';

describe('OtlpTraceFlusher - endpoint normalization', () => {
  beforeEach(() => {
    vi.mocked(OTLPTraceExporter).mockClear();
    exportFn.mockClear();
  });

  it('appends /v1/traces when not present', async () => {
    const flusher = new OtlpTraceFlusher({
      enabled: true,
      endpoint: 'https://example.com/apm/trace/opentelemetry',
      protocol: 'http/protobuf',
      headers: { 'x-key': 'val' },
      serviceName: 'test',
    });

    // Use test seam to bypass converter — triggers exporter creation
    await flusher.exportSpansForAgent('claude-code', []);
    await flusher.shutdown();

    expect(OTLPTraceExporter).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://example.com/apm/trace/opentelemetry/v1/traces',
      }),
    );
  });

  it('does not double-append if already ends with /v1/traces', async () => {
    const flusher = new OtlpTraceFlusher({
      enabled: true,
      endpoint: 'https://example.com/v1/traces',
      protocol: 'http/protobuf',
      headers: { 'x-key': 'val' },
      serviceName: 'test',
    });

    await flusher.exportSpansForAgent('codex', []);
    await flusher.shutdown();

    expect(OTLPTraceExporter).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://example.com/v1/traces',
      }),
    );
  });

  it('strips trailing slash before appending', async () => {
    const flusher = new OtlpTraceFlusher({
      enabled: true,
      endpoint: 'https://example.com/otlp/',
      protocol: 'http/protobuf',
      headers: { 'x-key': 'val' },
      serviceName: 'test',
    });

    await flusher.exportSpansForAgent('codex', []);
    await flusher.shutdown();

    expect(OTLPTraceExporter).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://example.com/otlp/v1/traces',
      }),
    );
  });
});
