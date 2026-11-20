import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ExportResultCode } from '@opentelemetry/core';
import type { ExportResult } from '@opentelemetry/core';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';
import * as stream from '../../../../src/flushers/turn-stream.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';
import type { TraceExporterLike } from '../../../../src/flushers/otlp-trace-flusher.js';

interface CapturedSpan extends ReadableSpan {
  attributes: Record<string, unknown>;
}

function makeCapturingExporter(captured: CapturedSpan[]): TraceExporterLike {
  return {
    export(spans: ReadableSpan[], cb: (r: ExportResult) => void): void {
      for (const s of spans) captured.push(s as CapturedSpan);
      cb({ code: ExportResultCode.SUCCESS });
    },
    shutdown: () => Promise.resolve(),
  };
}

// Trae-cn-style 4-span tree: ENTRY → AGENT → STEP → LLM(request+response).
// Mirrors the real hook-processor emission (assets/hooks/trae-cn-hook-processor.mjs
// entryRecord/agentRecord/stepRecord/llmRequestRecord/llmResponseRecord) so the
// test exercises the same convert path production runs.
function makeTraeCnTurnEntries(): AgentActivityEntry[] {
  const traceId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const turnId = 't-otlp-debug-001';
  const sessionId = 's-otlp-debug-001';
  const base = {
    'gen_ai.agent.type': 'trae-cn',
    'gen_ai.agent.name': 'trae-cn',
    'user.id': 'u1',
    trace_id: traceId,
    'gen_ai.turn.id': turnId,
    'gen_ai.session.id': sessionId,
  };
  return [
    {
      time_unix_nano: '1785760000000000000',
      observed_time_unix_nano: '1785760000000000000',
      'event.id': 'r1',
      event_name: 'other',
      'event.name': 'other',
      ...base,
      span_id: 'aaaaaaaaaaaaaaaa',
      parent_span_id: '',
      'gen_ai.span.kind': 'ENTRY',
      'gen_ai.operation.name': 'enter',
      'gen_ai.request.model': 'Doubao-Seed-Code',
      startTimeUnixNano: '1785760000000000000',
      endTimeUnixNano: '1785760005000000000',
    },
    {
      time_unix_nano: '1785760000100000000',
      observed_time_unix_nano: '1785760000100000000',
      'event.id': 'r2',
      event_name: 'other',
      'event.name': 'other',
      ...base,
      span_id: 'bbbbbbbbbbbbbbbb',
      parent_span_id: 'aaaaaaaaaaaaaaaa',
      'gen_ai.span.kind': 'AGENT',
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.request.model': 'Doubao-Seed-Code',
      'gen_ai.provider.name': 'doubao',
      startTimeUnixNano: '1785760000100000000',
      endTimeUnixNano: '1785760004000000000',
    },
    {
      time_unix_nano: '1785760000200000000',
      observed_time_unix_nano: '1785760000200000000',
      'event.id': 'r3',
      event_name: 'other',
      'event.name': 'other',
      ...base,
      span_id: 'cccccccccccccccc',
      parent_span_id: 'bbbbbbbbbbbbbbbb',
      'gen_ai.span.kind': 'STEP',
      'gen_ai.operation.name': 'react',
      'gen_ai.step.id': 'step-1',
      startTimeUnixNano: '1785760000200000000',
      endTimeUnixNano: '1785760003000000000',
    },
    {
      time_unix_nano: '1785760000300000000',
      observed_time_unix_nano: '1785760000300000000',
      'event.id': 'r4',
      event_name: 'llm.request',
      'event.name': 'llm.request',
      ...base,
      span_id: 'dddddddddddddddd',
      parent_span_id: 'cccccccccccccccc',
      'gen_ai.span.kind': 'LLM',
      'gen_ai.operation.name': 'chat',
      'gen_ai.step.id': 'step-1',
      'gen_ai.response.id': 'step-1:r',
      'gen_ai.provider.name': 'doubao',
      'gen_ai.request.model': 'Doubao-Seed-Code',
      'gen_ai.input.messages': [{ role: 'user', parts: [{ type: 'text', content: 'hello' }] }],
      startTimeUnixNano: '1785760000300000000',
      endTimeUnixNano: '1785760000350000000',
    },
    {
      time_unix_nano: '1785760000350000000',
      observed_time_unix_nano: '1785760000350000000',
      'event.id': 'r5',
      event_name: 'llm.response',
      'event.name': 'llm.response',
      ...base,
      span_id: 'dddddddddddddddd',
      parent_span_id: 'cccccccccccccccc',
      'gen_ai.span.kind': 'LLM',
      'gen_ai.operation.name': 'chat',
      'gen_ai.step.id': 'step-1',
      'gen_ai.response.id': 'step-1:r',
      'gen_ai.provider.name': 'doubao',
      'gen_ai.response.model': 'Doubao-Seed-Code',
      'gen_ai.response.finish_reasons': ['stop'],
      'gen_ai.usage.input_tokens': 10,
      'gen_ai.usage.output_tokens': 5,
      'gen_ai.usage.total_tokens': 15,
      'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content: 'hi' }], finish_reason: 'stop' }],
      startTimeUnixNano: '1785760000300000000',
      endTimeUnixNano: '1785760000350000000',
    },
  ] as unknown as AgentActivityEntry[];
}

describe('OtlpTraceFlusher - otlp-debug sink write via production sendBatch path', () => {
  let tmpDataDir: string;
  let expectedDebugDir: string;
  let captured: CapturedSpan[];
  let flusher: OtlpTraceFlusher;

  beforeEach(() => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otlp-debug-sink-'));
    expectedDebugDir = path.join(tmpDataDir, 'logs', 'otlp-debug');
    captured = [];
    // Force the convertEventLogToTrace fallback path. main's refactor routes
    // trae-cn through planTurnStream → createTurnStreamSession, but the
    // installed @loongsuite/otel-util-genai (v1.2.0) does not export
    // createTurnStreamSession. Mirror main's turn-streaming.test.ts spy
    // pattern to keep this regression test on the convert path it was
    // authored against.
    vi.spyOn(stream, 'planTurnStream').mockReturnValue(undefined);
    flusher = new OtlpTraceFlusher(
      {
        enabled: true,
        endpoints: [{ name: 'primary', endpoint: 'http://localhost:4318/v1/traces', headers: {} }],
        protocol: 'http/protobuf' as const,
        serviceName: 'test-pilot',
        debug: true,
        dataDir: tmpDataDir,
      },
      undefined,
      () => makeCapturingExporter(captured),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await flusher.shutdown();
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
  });

  it('sendBatch → flush → otlp-debug sink file contains converted spans (ENTRY/AGENT/STEP/LLM)', async () => {
    const entries = makeTraeCnTurnEntries();
    await flusher.sendBatch(entries);
    await flusher.flush();

    // The convert path should have produced spans and the capturing exporter
    // should have received them. This guards against the convert path
    // silently producing 0 spans (which would skip writeDebugLog at line 621).
    expect(captured.length).toBeGreaterThan(0);

    // The otlp-debug sink must have written a jsonl file under
    // <dataDir>/logs/otlp-debug/ containing the converted spans.
    expect(fs.existsSync(expectedDebugDir)).toBe(true);
    const files = fs.readdirSync(expectedDebugDir).filter((f) => f.endsWith('.jsonl'));
    expect(files.length).toBeGreaterThan(0);

    const debugFile = path.join(expectedDebugDir, files[0]);
    const lines = fs.readFileSync(debugFile, 'utf-8').split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);

    const spanKinds = new Set<string>();
    for (const line of lines) {
      const obj = JSON.parse(line);
      const attrs = obj.attributes ?? {};
      if (attrs['gen_ai.span.kind']) spanKinds.add(String(attrs['gen_ai.span.kind']));
    }
    // The 4 expected span kinds from a trae-cn turn tree.
    expect(spanKinds.has('ENTRY')).toBe(true);
    expect(spanKinds.has('AGENT')).toBe(true);
    expect(spanKinds.has('STEP')).toBe(true);
    expect(spanKinds.has('LLM')).toBe(true);
  });

  it('exports a late native response immediately and retains turn output on the Hook root', async () => {
    const events = makeTraeCnTurnEntries();
    const root = events.find(e => e['gen_ai.span.kind'] === 'ENTRY')!;
    const agent = events.find(e => e['gen_ai.span.kind'] === 'AGENT')!;
    const response = events.find(e => e['event.name'] === 'llm.response')!;
    const output = [{ role: 'assistant', parts: [{ type: 'text', content: 'all tests passed' }] }];
    const hook = { 'agent.trae-cn.source': 'content_hook' };
    await flusher.sendBatch([{ ...root, ...hook }, { ...agent, ...hook },
      { ...agent, ...hook, 'gen_ai.turn.end': true, 'gen_ai.output.messages': output }]);
    const history = '6affbf2b1968a773c6053633';
    const native = { ...response, 'agent.trae-cn.source': 'content_history', 'gen_ai.turn.id': 'native-turn',
      'gen_ai.response.id': history };
    await flusher.sendBatch([{ ...native, 'gen_ai.span.kind': 'STEP', span_id: '1234567890abcdef',
      parent_span_id: agent.span_id }, { ...native, parent_span_id: '1234567890abcdef' }]);
    expect(captured.map(s => s.attributes['gen_ai.span.kind'])).toEqual(['ENTRY', 'AGENT', 'STEP', 'LLM']);
    expect(captured[0].attributes['gen_ai.output.messages']).toBe(JSON.stringify(output));
    expect(captured[3].attributes['gen_ai.response.id']).toBe(history);
    expect(captured[3].parentSpanId).toBe(captured[2].spanContext().spanId);
  });

  it('does NOT write otlp-debug sink when debug=false', async () => {
    // Rebuild flusher with debug:false
    await flusher.shutdown();
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otlp-debug-sink-off-'));
    expectedDebugDir = path.join(tmpDataDir, 'logs', 'otlp-debug');
    captured = [];
    flusher = new OtlpTraceFlusher(
      {
        enabled: true,
        endpoints: [{ name: 'primary', endpoint: 'http://localhost:4318/v1/traces', headers: {} }],
        protocol: 'http/protobuf' as const,
        serviceName: 'test-pilot',
        debug: false,
        dataDir: tmpDataDir,
      },
      undefined,
      () => makeCapturingExporter(captured),
    );

    const entries = makeTraeCnTurnEntries();
    await flusher.sendBatch(entries);
    await flusher.flush();

    expect(captured.length).toBeGreaterThan(0);
    expect(fs.existsSync(expectedDebugDir)).toBe(false);
  });
});
