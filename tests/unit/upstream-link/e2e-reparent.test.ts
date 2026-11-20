import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  ParentBasedSampler,
  AlwaysOnSampler,
} from '@opentelemetry/sdk-trace-base';
import { convertEventLogToTrace, ExtendedTelemetryHandler } from '@loongsuite/otel-util-genai';
import type { EventLogRecord } from '@loongsuite/otel-util-genai';
import { CorrelationStore } from '../../../src/core/upstream-link/correlation-store.js';
import { TraceLinker } from '../../../src/core/upstream-link/trace-linker.js';
import { contentHash } from '../../../src/utils/content-hash.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { withUpstreamContextParent } from '../../../src/flushers/upstream-context-parent.js';
import { bindUpstreamTurn } from '../../../assets/hooks/shared/upstream-ingress.mjs';
import { planTurnStream } from '../../../src/flushers/turn-stream.js';
import {
  attachReservedToolSpanIds,
  ReservedSpanIdGenerator,
} from '../../../src/flushers/span-id-reservation.js';

const SID = 'ses_e2e';
const UP_TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const UP_SPAN = '00f067aa0ba902b7';
const TP = `00-${UP_TRACE}-${UP_SPAN}-01`;
const PROMPT = '场景检查里的野图怪物检查,需要在主页面加个配置';
const RESERVED_TOOL_SPAN = 'd4d4d4d4d4d4d4d4';

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
      'event.id': 'e-tool-call',
      'event.name': 'tool.call',
      'gen_ai.step.id': `${SID}:t1:s1`,
      'gen_ai.tool.name': 'Bash',
      'gen_ai.tool.call.id': 'tool-reserved',
      'gen_ai.tool.call.arguments': { command: 'my-cli' },
      span_id: RESERVED_TOOL_SPAN,
      parent_span_id: 'c3c3c3c3c3c3c3c3',
    },
    {
      ...base,
      time_unix_nano: String(t0 + 3e6),
      'event.id': 'e-tool-result',
      'event.name': 'tool.result',
      'gen_ai.step.id': `${SID}:t1:s1`,
      'gen_ai.tool.name': 'Bash',
      'gen_ai.tool.call.id': 'tool-reserved',
      'gen_ai.tool.call.result': 'ok',
      'tool.result.status': 'success',
      span_id: RESERVED_TOOL_SPAN,
      parent_span_id: 'c3c3c3c3c3c3c3c3',
    },
    {
      ...base,
      time_unix_nano: String(t0 + 4e6),
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

  it.each(['batch', 'stream'])('preserves remote sampling and tracestate through %s conversion without tools', async mode => {
    for (const sampled of [true, false]) {
      const records = buildTurn('ffeeddccbbaa99887766554433221100').filter(record => !String(record['event.name']).startsWith('tool.'));
      for (const record of records) record['agent.pilot.correlation.native_turn_id'] = `native-${mode}-${sampled}`;
      bindUpstreamTurn({ dataDir: dir, agentId: 'opencode', sessionId: SID, nativeTurnId: `native-${mode}-${sampled}`,
        carrier: { traceparent: TP.slice(0, -2) + (sampled ? '01' : '00'), tracestate: 'vendor=value,second=ok' } });
      const bindingDir = path.join(dir, 'acp-correlate');
      await new TraceLinker(new CorrelationStore(bindingDir), { retries: 0 }).stamp(records);
      const exporter = new InMemorySpanExporter();
      const provider = new BasicTracerProvider({ sampler: new ParentBasedSampler({ root: new AlwaysOnSampler() }), spanProcessors: [new SimpleSpanProcessor(exporter)] });
      const handler = withUpstreamContextParent(records, new ExtendedTelemetryHandler({ tracerProvider: provider }));
      if (mode === 'stream') {
        const stream = planTurnStream(records, { handler, passthroughKeys: [] });
        expect(stream).toBeDefined();
        await stream!(async () => { await provider.forceFlush(); });
      } else convertEventLogToTrace(records as EventLogRecord[], { handler, strict: false });
      await provider.forceFlush();
      const spans = exporter.getFinishedSpans();
      if (sampled) {
        expect(spans.some(span => span.parentSpanId === UP_SPAN)).toBe(true);
        expect(spans.every(span => span.spanContext().traceId === UP_TRACE && span.spanContext().traceFlags === 1
          && span.spanContext().traceState?.serialize() === 'vendor=value,second=ok')).toBe(true);
      } else expect(spans).toHaveLength(0);
      await provider.shutdown();
      fs.rmSync(bindingDir, { recursive: true, force: true });
    }
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
    const idGenerator = new ReservedSpanIdGenerator();
    const provider = new BasicTracerProvider({
      idGenerator,
      spanProcessors: [new SimpleSpanProcessor(inMem)],
    });
    const handler = new ExtendedTelemetryHandler({ tracerProvider: provider });
    const toolSpanIds = attachReservedToolSpanIds(handler, idGenerator);
    toolSpanIds.prepare(records);
    const result = convertEventLogToTrace(records as unknown as EventLogRecord[], { handler, strict: false });
    toolSpanIds.clear();
    await provider.forceFlush();
    const spans = inMem.getFinishedSpans();

    // 5. assertions
    expect(result.warnings).toEqual([]);
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.every((s) => s.spanContext().traceId === UP_TRACE)).toBe(true);
    expect(spans.every((s) => s.spanContext().traceId !== localTrace)).toBe(true);
    // ENTRY span's parent is the upstream span
    expect(spans.some((s) => s.parentSpanId === UP_SPAN)).toBe(true);
    // The converter preserves the TOOL span id reserved before Bash execution.
    expect(spans.some((s) => s.spanContext().spanId === RESERVED_TOOL_SPAN)).toBe(true);
  });
});
