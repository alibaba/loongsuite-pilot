import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ExportResultCode } from '@opentelemetry/core';
import * as fsUtils from '../../../../src/utils/fs-utils.js';

vi.mock('@loongsuite/otel-util-genai', () => ({
  convertEventLogToTrace: vi.fn(() => ({ traceIds: [], spanCount: 0, warnings: [] })),
  ExtendedTelemetryHandler: vi.fn().mockImplementation(() => ({})),
}));

let exportCallback: (r: { code: number; error?: Error }) => void;
const mockExport = vi.fn((_s: unknown, cb: (r: { code: number; error?: Error }) => void) => {
  exportCallback = cb;
  cb({ code: ExportResultCode.SUCCESS });
});

vi.mock('@opentelemetry/exporter-trace-otlp-proto', () => ({
  OTLPTraceExporter: vi.fn().mockImplementation(() => ({
    export: mockExport,
    shutdown: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.spyOn(fsUtils, 'appendLine').mockResolvedValue(undefined);
vi.spyOn(fsUtils, 'ensureDir').mockResolvedValue(undefined);

import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    endpoints: [{ name: 'primary', endpoint: 'http://localhost:4318', headers: { 'x-key': 'val' } }],
    protocol: 'http/protobuf' as const,
    serviceName: 'test-pilot',
    ...overrides,
  };
}

function makeMockSpan() {
  return {
    spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }),
    parentSpanId: undefined,
    name: 'test-span',
    kind: 0,
    startTime: [1000, 0] as [number, number],
    endTime: [1001, 0] as [number, number],
    attributes: { 'gen_ai.agent.type': 'claude-code' },
    status: { code: 0 },
    resource: { attributes: { 'service.name': 'test-pilot-claude-code' } },
  };
}

describe('OtlpTraceFlusher - export', () => {
  beforeEach(() => {
    mockExport.mockClear();
    vi.mocked(fsUtils.appendLine).mockClear();
    vi.mocked(fsUtils.ensureDir).mockClear();
  });

  it('calls exporter.export via exportSpansForAgent test seam', async () => {
    const flusher = new OtlpTraceFlusher(makeConfig());
    const spans = [makeMockSpan()] as any;

    await flusher.exportSpansForAgent('claude-code', spans);
    await flusher.shutdown();

    expect(mockExport).toHaveBeenCalledTimes(1);
  });

  it('writes debug file when debug=true', async () => {
    const flusher = new OtlpTraceFlusher(makeConfig({ debug: true }));
    const spans = [makeMockSpan()] as any;

    await flusher.exportSpansForAgent('claude-code', spans);
    await flusher.shutdown();

    expect(fsUtils.ensureDir).toHaveBeenCalled();
    expect(fsUtils.appendLine).toHaveBeenCalled();
    const writtenPath = vi.mocked(fsUtils.appendLine).mock.calls[0][0];
    expect(writtenPath).toContain('otlp-debug');
    expect(writtenPath).toContain('test-pilot-claude-code');
  });

  it('does NOT write debug file when debug=false', async () => {
    const flusher = new OtlpTraceFlusher(makeConfig({ debug: false }));
    const spans = [makeMockSpan()] as any;

    await flusher.exportSpansForAgent('claude-code', spans);
    await flusher.shutdown();

    const debugCalls = vi.mocked(fsUtils.appendLine).mock.calls.filter(
      (c) => (c[0] as string).includes('otlp-debug'),
    );
    expect(debugCalls).toHaveLength(0);
  });

  it('writes failed-log on export failure', async () => {
    mockExport.mockImplementationOnce((_s, cb) => {
      cb({ code: ExportResultCode.FAILED, error: new Error('401 unauthorized') });
    });

    const flusher = new OtlpTraceFlusher(makeConfig());
    const spans = [makeMockSpan()] as any;

    await flusher.exportSpansForAgent('claude-code', spans);
    await flusher.shutdown();

    const failedCalls = vi.mocked(fsUtils.appendLine).mock.calls.filter(
      (c) => (c[0] as string).includes('otlp-failed'),
    );
    expect(failedCalls.length).toBeGreaterThan(0);
    const written = JSON.parse(failedCalls[0][1] as string);
    expect(written._error).toBeDefined();
    expect(written._error.message).toContain('401');
  });

  it('exports small total size in a single call', async () => {
    // maxExportBatchBytes=10KB, each span ~522 bytes → 10 spans ≈ 5KB < 10KB → 1 batch
    const flusher = new OtlpTraceFlusher(makeConfig({ maxExportBatchBytes: 10 * 1024 }));
    const spans = Array.from({ length: 10 }, () => makeMockSpan()) as any;

    await flusher.exportSpansForAgent('claude-code', spans);
    await flusher.shutdown();

    expect(mockExport).toHaveBeenCalledTimes(1);
    expect(mockExport.mock.calls[0][0]).toHaveLength(10);
  });

  it('splits spans into batches by estimated size', async () => {
    // Each span with 4KB payload → ~4612 bytes estimated
    // maxExportBatchBytes=10KB → fits ~2 spans per batch
    // 5 spans → 3 batches (2+2+1)
    function makeLargeSpan() {
      return {
        ...makeMockSpan(),
        attributes: { 'gen_ai.agent.type': 'claude-code', 'gen_ai.input.messages': 'x'.repeat(4096) },
      };
    }
    const flusher = new OtlpTraceFlusher(makeConfig({ maxExportBatchBytes: 10 * 1024 }));
    const spans = Array.from({ length: 5 }, () => makeLargeSpan()) as any;

    await flusher.exportSpansForAgent('claude-code', spans);
    await flusher.shutdown();

    expect(mockExport).toHaveBeenCalledTimes(3);
    expect(mockExport.mock.calls[0][0]).toHaveLength(2);
    expect(mockExport.mock.calls[1][0]).toHaveLength(2);
    expect(mockExport.mock.calls[2][0]).toHaveLength(1);
  });

  it('uses default 10MB limit when maxExportBatchBytes not configured', async () => {
    // Small spans (~522 bytes each), 100 of them ≈ 52KB ≪ 10MB → single batch
    const flusher = new OtlpTraceFlusher(makeConfig());
    const spans = Array.from({ length: 100 }, () => makeMockSpan()) as any;

    await flusher.exportSpansForAgent('claude-code', spans);
    await flusher.shutdown();

    expect(mockExport).toHaveBeenCalledTimes(1);
    expect(mockExport.mock.calls[0][0]).toHaveLength(100);
  });

  it('enables gzip compression by default on OTLPTraceExporter', async () => {
    const flusher = new OtlpTraceFlusher(makeConfig());
    const spans = [makeMockSpan()] as any;

    await flusher.exportSpansForAgent('claude-code', spans);
    await flusher.shutdown();

    const MockExporter = vi.mocked(OTLPTraceExporter);
    expect(MockExporter).toHaveBeenCalled();
    const ctorArg = MockExporter.mock.calls[0][0] as Record<string, unknown>;
    expect(ctorArg.compression).toBe('gzip');
  });

  it('writes to BOTH debug and failed-log when debug=true and export fails', async () => {
    mockExport.mockImplementationOnce((_s, cb) => {
      cb({ code: ExportResultCode.FAILED, error: new Error('timeout') });
    });

    const flusher = new OtlpTraceFlusher(makeConfig({ debug: true }));
    const spans = [makeMockSpan()] as any;

    await flusher.exportSpansForAgent('claude-code', spans);
    await flusher.shutdown();

    const allCalls = vi.mocked(fsUtils.appendLine).mock.calls;
    const debugCalls = allCalls.filter((c) => (c[0] as string).includes('otlp-debug'));
    const failedCalls = allCalls.filter((c) => (c[0] as string).includes('otlp-failed'));
    expect(debugCalls.length).toBeGreaterThan(0);
    expect(failedCalls.length).toBeGreaterThan(0);
  });
});

describe('OtlpTraceFlusher - multi-backend fan-out', () => {
  beforeEach(() => {
    vi.mocked(fsUtils.appendLine).mockClear();
    vi.mocked(fsUtils.ensureDir).mockClear();
  });

  function twoEndpointConfig(overrides: Record<string, unknown> = {}) {
    return {
      enabled: true,
      endpoints: [
        { name: 'backend-a', endpoint: 'http://a:4318' },
        { name: 'backend-b', endpoint: 'http://b:4318' },
      ],
      protocol: 'http/protobuf' as const,
      serviceName: 'test-pilot',
      ...overrides,
    };
  }

  it('exports the same spans to every backend once', async () => {
    const calls: Record<string, number> = {};
    const factory = (opts: { name: string }) => ({
      export: (_spans: any, cb: (r: { code: number }) => void) => {
        calls[opts.name] = (calls[opts.name] ?? 0) + 1;
        cb({ code: ExportResultCode.SUCCESS });
      },
      shutdown: vi.fn().mockResolvedValue(undefined),
    });

    const flusher = new OtlpTraceFlusher(twoEndpointConfig(), undefined, factory as any);
    await flusher.exportSpansForAgent('claude-code', [makeMockSpan()] as any);
    await flusher.shutdown();

    expect(calls['backend-a']).toBe(1);
    expect(calls['backend-b']).toBe(1);
  });

  it('isolates a failing backend and still exports to the healthy one', async () => {
    const factory = (opts: { name: string }) => ({
      export: (_spans: any, cb: (r: { code: number; error?: Error }) => void) => {
        if (opts.name === 'backend-b') {
          cb({ code: ExportResultCode.FAILED, error: new Error('503 from b') });
        } else {
          cb({ code: ExportResultCode.SUCCESS });
        }
      },
      shutdown: vi.fn().mockResolvedValue(undefined),
    });

    const flusher = new OtlpTraceFlusher(twoEndpointConfig(), undefined, factory as any);
    await flusher.exportSpansForAgent('claude-code', [makeMockSpan()] as any);
    await flusher.shutdown();

    const failedCalls = vi.mocked(fsUtils.appendLine).mock.calls.filter(
      (c) => (c[0] as string).includes('otlp-failed'),
    );
    // only backend-b failed → exactly its endpoint-tagged file is written
    expect(failedCalls.length).toBeGreaterThan(0);
    expect(failedCalls.every((c) => (c[0] as string).includes('__backend-b'))).toBe(true);
    expect(failedCalls.some((c) => (c[0] as string).includes('__backend-a'))).toBe(false);
  });

  it('sanitizes a malicious endpoint name in the failed-log path', async () => {
    const factory = () => ({
      export: (_spans: any, cb: (r: { code: number; error?: Error }) => void) =>
        cb({ code: ExportResultCode.FAILED, error: new Error('boom') }),
      shutdown: vi.fn().mockResolvedValue(undefined),
    });

    const cfg = {
      enabled: true,
      endpoints: [{ name: '../../../../tmp/pwn', endpoint: 'http://evil:4318' }],
      protocol: 'http/protobuf' as const,
      serviceName: 'test-pilot',
    };
    const flusher = new OtlpTraceFlusher(cfg, undefined, factory as any);
    await flusher.exportSpansForAgent('claude-code', [makeMockSpan()] as any);
    await flusher.shutdown();

    const failedCalls = vi.mocked(fsUtils.appendLine).mock.calls.filter(
      (c) => (c[0] as string).includes('otlp-failed'),
    );
    expect(failedCalls.length).toBeGreaterThan(0);
    // separators are replaced so the name stays a single file inside otlp-failed
    // (embedded dots are harmless without separators — no directory traversal)
    for (const c of failedCalls) {
      const p = c[0] as string;
      expect(p).toContain('otlp-failed');
      expect(p).not.toContain('/tmp/pwn');
      expect(p).toContain('.._.._.._.._tmp_pwn'); // slashes → '_', dots kept
    }
  });
});
