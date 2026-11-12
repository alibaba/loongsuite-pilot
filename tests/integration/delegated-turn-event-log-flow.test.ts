import { describe, it, expect } from 'vitest';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { OtlpTraceFlusher, type TraceExporterLike } from '../../src/flushers/otlp-trace-flusher.js';
import { transformHookRecord } from '../../src/inputs/base/hook-record-transform.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TraceLinker } from '../../src/core/upstream-link/trace-linker.js';
import { CorrelationStore } from '../../src/core/upstream-link/correlation-store.js';
import { contentHash } from '../../src/utils/content-hash.js';
import { ClientType } from '../../src/types/index.js';

const traceId = 'a'.repeat(32);
const toolSpanId = 'b'.repeat(16);
function turn(agent: string, id: string, offset: number, child = false) {
  const base = {
    trace_id: traceId, 'gen_ai.agent.type': agent, 'gen_ai.session.id': id,
    'gen_ai.turn.id': id, 'gen_ai.step.id': id + ':step', 'user.id': 'initiator',
    'gen_ai.provider.name': 'openai', 'gen_ai.request.model': 'test-model',
    ...(child ? { parent_span_id: toolSpanId, 'gen_ai.agent.scope': 'subagent',
      'gen_ai.agent.parent.id': 'parent', 'gen_ai.subagent.parent_tool_call.id': 'spawn' } : {}),
  };
  const event = (name: string, tick: number, fields = {}) => ({ ...base, 'event.name': name,
    'event.id': `${id}-${tick}`, time_unix_nano: String(1700000000000000000n + BigInt(offset + tick) * 1000000n), ...fields });
  return [
    event('other', 0, { 'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: 'task' }] }], 'gen_ai.input.messages': [{ role: 'user', parts: [{ type: 'text', content: 'task' }] }] }),
    event('llm.request', 1, { 'gen_ai.response.id': id + '-llm', 'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: 'task' }] }] }),
    event('llm.response', 2, { 'gen_ai.response.id': id + '-llm', 'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content: 'done' }] }],
      'gen_ai.usage.input_tokens': 11, 'gen_ai.usage.output_tokens': 7, 'gen_ai.response.finish_reasons': [child ? 'stop' : 'tool_calls'] }),
    ...(!child ? [event('tool.call', 3, { span_id: toolSpanId, 'gen_ai.tool.call.id': 'spawn', 'gen_ai.tool.name': agent === 'hermes' ? 'delegate_task' : 'sessions_spawn', 'gen_ai.tool.call.arguments': { task: 'child' } }),
      event('tool.result', 4, { span_id: toolSpanId, 'gen_ai.tool.call.id': 'spawn', 'gen_ai.tool.name': agent === 'hermes' ? 'delegate_task' : 'sessions_spawn', 'gen_ai.tool.call.result': { accepted: true } })] : []),
    event('other', 5, { 'gen_ai.turn.end': true, 'agent.openclaw.hook': 'llm_output' }),
  ];
}

describe.each(['hermes', 'openclaw'])('%s independently flushed child turns', agent => {
  it.each([false, true])('keeps late children under the reserved tool (child correlation files=%s)', async withCorrelation => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delegated-upstream-'));
    const upstreamTrace = 'c'.repeat(32);
    const upstreamParent = 'd'.repeat(16);
    if (withCorrelation) {
      for (const id of ['child-a', 'child-b']) {
        fs.writeFileSync(path.join(directory, `${id}.jsonl`), JSON.stringify({
          type: 'turn', contentHash: contentHash('task'),
          traceparent: `00-${upstreamTrace}-${upstreamParent}-01`,
        }) + '\n');
      }
    }
    const store = new CorrelationStore(directory);
    const linker = new TraceLinker(store, { retries: 0 });
    const spans: ReadableSpan[] = [];
    const exporter: TraceExporterLike = { export(batch, cb) { spans.push(...batch); cb({ code: 0 }); }, shutdown: async () => {} };
    const f = new OtlpTraceFlusher({ enabled: true, protocol: 'http/protobuf', serviceName: 'subagent-test', endpoints: [{ name: 'test', endpoint: 'http://localhost:4318', headers: {} }] }, undefined, () => exporter);
    const send = async (records: Record<string, unknown>[]) => {
      const entries = await Promise.all(records.map(r => transformHookRecord(r, agent === 'hermes' ? ClientType.Hermes : ClientType.OpenClaw, agent)));
      const normalized = entries.filter(e => e !== null);
      // Exercise cross-batch linking before the real production OTLP converter.
      for (const entry of normalized) await linker.stamp([entry]);
      await f.sendBatch(normalized); await f.flush();
    };
    try {
      await send(turn(agent, 'parent', 0));
      const count = spans.length;
      expect(count).toBeGreaterThan(0);
      await send(turn(agent, 'child-a', 100, true));
      // Hermes native hooks can emit only LLM/tool records, with no input `other`.
      await send(turn(agent, 'child-b', 200, true).filter(r => r['event.name'] !== 'other'));
      expect(new Set(spans.map(s => s.spanContext().spanId)).size).toBe(spans.length);
      expect(new Set(spans.map(s => s.spanContext().traceId))).toEqual(new Set([traceId]));
      expect(spans.filter(s => s.attributes['gen_ai.span.kind'] === 'ENTRY')).toHaveLength(1);
      const children = spans.filter(s => s.attributes['gen_ai.span.kind'] === 'AGENT' && s.attributes['gen_ai.agent.scope'] === 'subagent');
      expect(children).toHaveLength(2);
      expect(children.every(s => s.parentSpanId === toolSpanId)).toBe(true);
      expect(new Set(children.map(s => s.attributes['gen_ai.session.id']))).toEqual(new Set(['child-a', 'child-b']));
      expect(spans.every(s => s.attributes['gen_ai.user.id'] === 'initiator')).toBe(true);
      const llms = spans.filter(s => s.attributes['gen_ai.span.kind'] === 'LLM');
      expect(llms).toHaveLength(3);
      expect(llms.reduce((n, s) => n + Number(s.attributes['gen_ai.usage.input_tokens']), 0)).toBe(33);
      const tool = spans.find(s => s.spanContext().spanId === toolSpanId)!;
      expect(tool.endTime[1] - tool.startTime[1]).toBe(1_000_000);
      if (withCorrelation) {
        // Preserving native delegation must not consume an unrelated upstream record.
        expect(store.resolveTurn('child-a', 'task', 'independent')).toBe(`00-${upstreamTrace}-${upstreamParent}-01`);
      }
    } finally {
      await f.shutdown();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
