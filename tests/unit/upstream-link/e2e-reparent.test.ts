import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { convertEventLogToTrace, ExtendedTelemetryHandler } from '@loongsuite/otel-util-genai';
import type { EventLogRecord } from '@loongsuite/otel-util-genai';
import { CorrelationStore } from '../../../src/core/upstream-link/correlation-store.js';
import { TraceLinker } from '../../../src/core/upstream-link/trace-linker.js';
import { contentHash } from '../../../src/utils/content-hash.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';

const SID = 'ses_e2e';
const UP_TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const UP_SPAN = '00f067aa0ba902b7';
const TP = `00-${UP_TRACE}-${UP_SPAN}-01`;
const PROMPT = '场景检查里的野图怪物检查,需要在主页面加个配置';

// A synthetic opencode-style turn: other (user input) + llm.request + llm.response.
function buildTurn(localTrace: string): AgentActivityEntry[] {
  const base = {
    trace_id: localTrace,
    'gen_ai.session.id': SID,
    'gen_ai.turn.id': `${SID}:t1`,
    'gen_ai.agent.type': 'opencode',
    'gen_ai.provider.name': 'anthropic',
  };
  const t0 = Date.now() * 1e6;
  return [
    {
      ...base,
      time_unix_nano: String(t0),
      'event.id': 'e-other',
      'event.name': 'other',
      span_id: 'a1a1a1a1a1a1a1a1',
      'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: PROMPT }] }],
    },
    {
      ...base,
      time_unix_nano: String(t0 + 1e6),
      'event.id': 'e-req',
      'event.name': 'llm.request',
      'gen_ai.step.id': `${SID}:t1:s1`,
      span_id: 'b2b2b2b2b2b2b2b2',
      parent_span_id: 'c3c3c3c3c3c3c3c3',
      'gen_ai.request.model': 'claude',
    },
    {
      ...base,
      time_unix_nano: String(t0 + 2e6),
      'event.id': 'e-resp',
      'event.name': 'llm.response',
      'gen_ai.step.id': `${SID}:t1:s1`,
      span_id: 'b2b2b2b2b2b2b2b2',
      parent_span_id: 'c3c3c3c3c3c3c3c3',
      'gen_ai.request.model': 'claude',
      'gen_ai.response.model': 'claude',
      'gen_ai.response.finish_reasons': ['stop'],
      'gen_ai.usage.input_tokens': 10,
      'gen_ai.usage.output_tokens': 20,
    },
  ] as unknown as AgentActivityEntry[];
}

describe('upstream-link e2e: stamp -> real converter reparents to upstream span', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-e2e-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('all spans share upstream traceId and ENTRY hangs under the upstream span', async () => {
    // 1. correlation record (as an adapter would write, scheme2)
    fs.writeFileSync(
      path.join(dir, `${SID}.jsonl`),
      JSON.stringify({ type: 'turn', sessionId: SID, contentHash: contentHash(PROMPT), contentPrefix: PROMPT.slice(0, 128), traceparent: TP }) + '\n',
    );

    // 2. collected turn with a local (random) trace_id that must be overridden
    const localTrace = 'ffeeddccbbaa99887766554433221100';
    const records = buildTurn(localTrace);

    // 3. stamp
    await new TraceLinker(new CorrelationStore(dir), { retries: 0 }).stamp(records);

    // 4. run the REAL converter
    const inMem = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(inMem)] });
    const handler = new ExtendedTelemetryHandler({ tracerProvider: provider });
    const result = convertEventLogToTrace(records as unknown as EventLogRecord[], { handler, strict: false });
    await provider.forceFlush();
    const spans = inMem.getFinishedSpans();

    // 5. assertions
    expect(result.warnings).toEqual([]);
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.every((s) => s.spanContext().traceId === UP_TRACE)).toBe(true);
    expect(spans.every((s) => s.spanContext().traceId !== localTrace)).toBe(true);
    // ENTRY span's parent is the upstream span
    expect(spans.some((s) => s.parentSpanId === UP_SPAN)).toBe(true);
  });
});
