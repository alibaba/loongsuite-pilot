import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
import type { AgentActivityEntry } from '../../../../src/types/index.js';

function makeConfig() {
  return {
    enabled: true,
    endpoint: 'http://localhost:4318',
    protocol: 'http/protobuf' as const,
    headers: { 'x-key': 'val' },
    serviceName: 'test-pilot',
  };
}

// Minimal ReadableSpan-like object — augmentToolSpans reads/writes attributes only.
function makeToolSpan(callId: string, result: string | undefined): any {
  const attrs: Record<string, unknown> = {
    'gen_ai.operation.name': 'execute_tool',
    'gen_ai.tool.call.id': callId,
    'gen_ai.tool.name': 'execute_bash',
  };
  if (result !== undefined) attrs['gen_ai.tool.call.result'] = result;
  return {
    spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }),
    parentSpanId: undefined,
    name: 'execute_tool execute_bash',
    kind: 0,
    startTime: [1000, 0] as [number, number],
    endTime: [1001, 0] as [number, number],
    attributes: attrs,
    status: { code: 0 },
    resource: { attributes: {} },
  };
}

// S1b 修复（tester 报告 P1）：TOOL span 缺失 gen_ai.tool.call.status /
// gen_ai.tool.error / gen_ai.tool.output，从事件日志 tool.result 记录回填。
describe('OtlpTraceFlusher - augmentToolSpans (S1b fix)', () => {
  let flusher: OtlpTraceFlusher;

  beforeEach(() => {
    flusher = new OtlpTraceFlusher(makeConfig());
  });

  afterEach(async () => {
    await flusher.shutdown();
  });

  it('error result: sets status=error + tool.error JSON + tool.output=error.message', () => {
    const records = [
      {
        'event.name': 'tool.result',
        'gen_ai.tool.call.id': 'call-1',
        'tool.result.status': 'error',
        'error.type': 'ToolError',
        'error.message': 'exit_status 2: ls: cannot access /tmp/no-such-dir: No such file or directory',
      },
    ] as unknown as AgentActivityEntry[];
    const spans = [makeToolSpan('call-1', '[object Object]')];

    (flusher as any).augmentToolSpans(records, spans);

    const attrs = spans[0].attributes;
    expect(attrs['gen_ai.tool.call.status']).toBe('error');
    const err = JSON.parse(attrs['gen_ai.tool.error'] as string);
    expect(err.type).toBe('ToolError');
    expect(err.message).toContain('exit_status 2');
    expect(attrs['gen_ai.tool.output']).toContain('No such file or directory');
  });

  it('success result: sets status=success + tool.output=result text', () => {
    const records = [
      {
        'event.name': 'tool.result',
        'gen_ai.tool.call.id': 'call-2',
        'tool.result.status': 'success',
      },
    ] as unknown as AgentActivityEntry[];
    const spans = [makeToolSpan('call-2', '{"exit_status":"0","stdout":"/usr/bin/bash\\n"}')];

    (flusher as any).augmentToolSpans(records, spans);

    const attrs = spans[0].attributes;
    expect(attrs['gen_ai.tool.call.status']).toBe('success');
    expect(attrs['gen_ai.tool.error']).toBeUndefined();
    expect(attrs['gen_ai.tool.output']).toBe('{"exit_status":"0","stdout":"/usr/bin/bash\\n"}');
  });

  it('missing tool.result record: defaults status=success + empty output', () => {
    const records: AgentActivityEntry[] = [];
    const spans = [makeToolSpan('orphan-call', undefined)];

    (flusher as any).augmentToolSpans(records, spans);

    const attrs = spans[0].attributes;
    expect(attrs['gen_ai.tool.call.status']).toBe('success');
    expect(attrs['gen_ai.tool.output']).toBe('');
  });

  it('skips non-TOOL spans (no gen_ai.operation.name=execute_tool)', () => {
    const llmSpan = {
      attributes: {
        'gen_ai.operation.name': 'chat',
        'gen_ai.tool.call.id': 'call-3',
      },
    } as any;
    const records = [
      {
        'event.name': 'tool.result',
        'gen_ai.tool.call.id': 'call-3',
        'tool.result.status': 'error',
        'error.type': 'ToolError',
        'error.message': 'boom',
      },
    ] as unknown as AgentActivityEntry[];

    (flusher as any).augmentToolSpans(records, [llmSpan]);

    expect(llmSpan.attributes['gen_ai.tool.call.status']).toBeUndefined();
    expect(llmSpan.attributes['gen_ai.tool.error']).toBeUndefined();
    expect(llmSpan.attributes['gen_ai.tool.output']).toBeUndefined();
  });

  it('error without error.type/error.message: falls back to ToolError / empty', () => {
    const records = [
      {
        'event.name': 'tool.result',
        'gen_ai.tool.call.id': 'call-4',
        'tool.result.status': 'error',
      },
    ] as unknown as AgentActivityEntry[];
    const spans = [makeToolSpan('call-4', 'some-result')];

    (flusher as any).augmentToolSpans(records, spans);

    const attrs = spans[0].attributes;
    expect(attrs['gen_ai.tool.call.status']).toBe('error');
    const err = JSON.parse(attrs['gen_ai.tool.error'] as string);
    expect(err.type).toBe('ToolError');
    expect(err.message).toBe('');
    expect(attrs['gen_ai.tool.output']).toBe('');
  });
});
