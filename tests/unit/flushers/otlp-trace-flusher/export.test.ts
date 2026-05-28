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

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    endpoint: 'http://localhost:4318',
    protocol: 'http/protobuf' as const,
    headers: { 'x-key': 'val' },
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
