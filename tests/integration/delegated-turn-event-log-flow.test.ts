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
import { CodexTurnJournal } from '../../src/flushers/codex-turn-journal.js';

const traceId = 'a'.repeat(32);
const toolSpanId = 'b'.repeat(16);
function turn(agent: string, id: string, offset: number, child = false) {
  const base = {
    trace_id: traceId, 'gen_ai.agent.type': agent, 'gen_ai.session.id': id,
    'gen_ai.turn.id': id, 'gen_ai.step.id': id + ':step', 'user.id': 'initiator',
    'gen_ai.provider.name': 'openai', 'gen_ai.request.model': 'test-model',
    ...(child ? { parent_span_id: toolSpanId, 'gen_ai.agent.scope': 'subagent',
      'gen_ai.agent.parent.invocation.id': 'work-1',
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
  it('retains a running child across collector restart and acknowledges its complete trace once', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delegated-restart-'));
    const spans: ReadableSpan[] = [];
    const exporter: TraceExporterLike = { export(batch, cb) { spans.push(...batch); cb({ code: 0 }); }, shutdown: async () => {} };
    const create = () => new OtlpTraceFlusher({ enabled: true, protocol: 'http/protobuf', serviceName: 'restart-test', endpoints: [{ name: 'test', endpoint: 'http://localhost:4318', headers: {} }] }, undefined, () => exporter,
      new CodexTurnJournal(directory, 10_000, ['codex', 'hermes', 'openclaw']));
    const child = turn(agent, 'running-child', 100, true);
    const base = child[0];
    const extra = (name: string, tick: number, fields = {}) => ({ ...base, 'event.name': name, 'event.id': `extra-${tick}`,
      time_unix_nano: String(1700000000000000000n + BigInt(tick) * 1000000n), ...fields });
    child[2]['gen_ai.response.finish_reasons'] = ['tool_calls'];
    child[2]['gen_ai.output.messages'] = [{ role: 'assistant', parts: [{ type: 'tool_call', id: 'read-child', name: 'read' }] }];
    const prefix = [...child.slice(0, 3), extra('tool.call', 103, { span_id: 'e'.repeat(16), 'gen_ai.tool.call.id': 'read-child', 'gen_ai.tool.name': 'read', 'gen_ai.tool.call.arguments': { path: 'alpha.txt' } })];
    const suffix = [extra('tool.result', 120, { span_id: 'e'.repeat(16), 'gen_ai.tool.call.id': 'read-child', 'gen_ai.tool.name': 'read', 'gen_ai.tool.call.result': 'alpha' }),
      extra('llm.request', 121, { 'gen_ai.step.id': 'second-step', 'gen_ai.response.id': 'second-llm', 'gen_ai.input.messages': [{ role: 'tool', parts: [{ type: 'tool_call_response', id: 'read-child', response: 'alpha' }] }] }),
      extra('llm.response', 130, { 'gen_ai.step.id': 'second-step', 'gen_ai.response.id': 'second-llm', 'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content: 'done' }] }], 'gen_ai.response.finish_reasons': ['stop'], 'gen_ai.usage.input_tokens': 13, 'gen_ai.usage.output_tokens': 3 }),
      extra('other', 131, { 'gen_ai.turn.end': true, 'agent.openclaw.hook': 'llm_output' })];
    if (agent === 'hermes') for (const row of [...prefix, ...suffix]) row['agent.hermes.collection'] = 'realtime-v1';
    const normalize = async (records: Record<string, unknown>[]) => (await Promise.all(records.map(record => transformHookRecord(record, agent === 'hermes' ? ClientType.Hermes : ClientType.OpenClaw, agent)))).filter(entry => entry !== null);
    let flusher = create();
    try {
      await flusher.sendBatch(await normalize(turn(agent, 'parent', 0)));
      const parentCount = spans.length;
      await flusher.sendBatch(await normalize(prefix));
      await flusher.shutdown();
      expect(spans).toHaveLength(parentCount);
      flusher = create();
      await flusher.start();
      await flusher.sendBatch(await normalize(suffix));
      await flusher.flush();
      const own = spans.filter(span => span.attributes['gen_ai.session.id'] === 'running-child');
      expect(own.filter(span => span.attributes['gen_ai.span.kind'] === 'AGENT')).toHaveLength(1);
      expect(own.filter(span => span.attributes['gen_ai.span.kind'] === 'STEP')).toHaveLength(2);
      const llms = own.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM');
      expect(llms).toHaveLength(2);
      expect(llms.reduce((sum, span) => sum + Number(span.attributes['gen_ai.usage.input_tokens']), 0)).toBe(24);
      const tool = own.find(span => span.spanContext().spanId === 'e'.repeat(16))!;
      expect(JSON.parse(String(tool.attributes['gen_ai.tool.call.arguments']))).toEqual({ path: 'alpha.txt' });
      expect(tool.endTime[1] - tool.startTime[1]).toBe(17_000_000);
      const count = spans.length;
      await flusher.shutdown();
      flusher = create();
      await flusher.sendBatch(await normalize([...prefix, ...suffix]));
      await flusher.flush();
      expect(spans).toHaveLength(count);
    } finally { await flusher.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); }
  });

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
      await send([{ ...turn(agent, 'parent', 0)[0], 'event.name': 'gen_ai.agent.invoke',
        'event.id': 'invoke', 'gen_ai.agent.invocation.id': 'work-1' }]);
      expect(spans).toHaveLength(count);
      await send(turn(agent, 'child-a', 100, true));
      // Hermes native hooks can emit only LLM/tool records, with no input `other`.
      await send(turn(agent, 'child-b', 200, true).filter(r => r['event.name'] !== 'other'));
      expect(new Set(spans.map(s => s.spanContext().spanId)).size).toBe(spans.length);
      expect(new Set(spans.map(s => s.spanContext().traceId))).toEqual(new Set([traceId]));
      expect(spans.filter(s => s.attributes['gen_ai.span.kind'] === 'ENTRY')).toHaveLength(1);
      expect(spans.find(s => s.attributes['gen_ai.span.kind'] === 'ENTRY')?.parentSpanId).toBeUndefined();
      const children = spans.filter(s => s.attributes['gen_ai.span.kind'] === 'AGENT' && s.attributes['gen_ai.agent.scope'] === 'subagent');
      expect(children).toHaveLength(2);
      expect(children.every(s => s.parentSpanId === toolSpanId)).toBe(true);
      expect(children.every(s => s.attributes['gen_ai.agent.parent.invocation.id'] === 'work-1')).toBe(true);
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

  it.each(['d'.repeat(16), '0000000000000001'])('preserves an explicit upstream parent %s', async parent => {
    const spans: ReadableSpan[] = [];
    const exporter: TraceExporterLike = { export(batch, cb) { spans.push(...batch); cb({ code: 0 }); }, shutdown: async () => {} };
    const flusher = new OtlpTraceFlusher({ enabled: true, protocol: 'http/protobuf', serviceName: 'upstream-test', endpoints: [{ name: 'test', endpoint: 'http://localhost:4318', headers: {} }] }, undefined, () => exporter);
    try {
      const records = turn(agent, 'upstream-turn', 0).map(record => ({ ...record,
        ...(record['event.name'] === 'other' ? { parent_span_id: parent } : {}) }));
      const entries = await Promise.all(records.map(record => transformHookRecord(record, agent === 'hermes' ? ClientType.Hermes : ClientType.OpenClaw, agent)));
      await flusher.sendBatch(entries.filter(entry => entry !== null));
      await flusher.flush();
      const entry = spans.find(span => span.attributes['gen_ai.span.kind'] === 'ENTRY');
      expect(entry?.spanContext().traceId).toBe(traceId);
      expect(entry?.parentSpanId).toBe(parent);
    } finally { await flusher.shutdown(); }
  });
});
