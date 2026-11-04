import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';
import * as stream from '../../../../src/flushers/turn-stream.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';

function turn(count = 40, delegated = false, agent = 'openclaw'): AgentActivityEntry[] {
  const base = { trace_id: '1234567890abcdef1234567890abcdef', 'gen_ai.turn.id': 'long-turn',
    'gen_ai.agent.type': agent, 'gen_ai.agent.id': 'main', 'gen_ai.agent.name': 'test-agent',
    'gen_ai.session.id': 'session', 'user.id': 'test-user', 'gen_ai.provider.name': 'test',
    ...(delegated ? { 'gen_ai.agent.scope': 'subagent', parent_span_id: '1111111111111111' } : {}) };
  const event = (name: string, time: number, fields = {}) => ({ ...base, 'event.name': name,
    'event.id': `event-${time}`, time_unix_nano: `${1700000000000 + time}000000`, ...fields } as AgentActivityEntry);
  const message = (role: string, text: string) => [{ role, parts: [{ type: 'text', content: text }] }];
  const records = [event('other', 0, { 'agent.openclaw.hook': 'before_agent_run',
    'gen_ai.input.messages_delta': message('user', 'task') })];
  for (let i = 0; i < count; i++) {
    const common = { 'gen_ai.step.id': `step_${i}`, 'gen_ai.response.id': `response-${i}` };
    records.push(event('llm.request', i * 100 + 1, { ...common, span_id: (i + 1).toString(16).padStart(16, '0'),
      'gen_ai.request.model': 'test-model', 'gen_ai.react.round': i,
      'gen_ai.input.messages_delta': message('user', `delta-${i}`),
      ...(i === 0 || i === 20 ? { 'gen_ai.input.messages': message('user', `anchor-${i}`) } : {}),
      ...(i === count - 1 ? { 'test.late': 'available-at-conversion' } : {}),
      ...(i === 10 ? { 'gen_ai.system_instructions': [{ type: 'text', content: 'late-system' }],
        'gen_ai.tool.definitions': [{ type: 'function', name: 'read', description: 'read data' }] } : {}),
    }), event('llm.response', i * 100 + 2, { ...common, span_id: (i + 1).toString(16).padStart(16, '0'),
      'gen_ai.response.model': 'test-model', 'gen_ai.response.finish_reasons': ['tool_calls'],
      'gen_ai.output.messages': message('assistant', `output-${i}`),
      'gen_ai.usage.input_tokens': 100 + i, 'gen_ai.usage.output_tokens': 10 + i,
      'gen_ai.usage.total_tokens': 110 + 2 * i, 'gen_ai.usage.reasoning_tokens': i,
      'gen_ai.usage.cache_read.input_tokens': 1, 'gen_ai.usage.cache_creation.input_tokens': 2,
    }), event('tool.call', i * 100 + 3, { ...common, span_id: (i + 10000).toString(16).padStart(16, '0'),
      'gen_ai.tool.name': 'read', 'gen_ai.tool.call.id': `tool-${i}`, 'gen_ai.tool.call.arguments': { path: `file-${i}` },
      'gen_ai.skill.name': 'reader',
    }), event('tool.result', i * 100 + 4, { ...common, span_id: (i + 10000).toString(16).padStart(16, '0'),
      'gen_ai.tool.name': 'read', 'gen_ai.tool.call.id': `tool-${i}`, 'gen_ai.tool.call.result': { text: `result-${i}` },
      'tool.result.status': i === 5 ? 'failure' : 'success', ...(i === 5 ? { 'error.type': 'TestToolFailure' } : {}),
    }));
  }
  // A tool result beyond the stream grace window must remain with its real step.
  const late = records.splice(4, 1)[0];
  late['test.precedence'] = 'late-tool-result';
  records[4]['test.precedence'] = 'earlier-source-record';
  records.push(late, event('other', count * 100 + 5, { 'agent.openclaw.hook': 'llm_output', 'gen_ai.turn.end': true }));
  return records;
}

async function collect(records: AgentActivityEntry[], batch = false, maxExportBatchBytes = 5000) {
  const spans: ReadableSpan[][] = [];
  if (batch) vi.spyOn(stream, 'planTurnStream').mockReturnValueOnce(undefined);
  const flusher = new OtlpTraceFlusher({ enabled: true, protocol: 'http/protobuf', serviceName: 'stream-test',
    maxExportBatchBytes,
    spanAttributePassthroughPrefixes: ['test.'], endpoints: [{ name: 'test', endpoint: 'http://127.0.0.1:4318' }] },
    undefined, () => ({ export(batch, callback) { spans.push([...batch]); callback({ code: 0 }); }, shutdown: async () => {} }));
  try { await flusher.sendBatch(records); } finally { await flusher.shutdown(); }
  return spans;
}

function snapshot(spans: ReadableSpan[]) {
  const byId = new Map(spans.map(s => [s.spanContext().spanId, s]));
  const key = (s: ReadableSpan) => `${s.attributes['gen_ai.span.kind']}:${s.attributes['gen_ai.response.id'] ?? s.attributes['gen_ai.tool.call.id'] ?? s.attributes['gen_ai.react.round'] ?? ''}`;
  return spans.map(s => ({ key: key(s), name: s.name, trace: s.spanContext().traceId,
    parent: byId.has(s.parentSpanId!) ? key(byId.get(s.parentSpanId!)!) : s.parentSpanId,
    start: s.startTime, end: s.endTime, status: s.status,
    attributes: Object.fromEntries(Object.entries(s.attributes).sort(([a], [b]) => a.localeCompare(b))),
  })).sort((a, b) => a.key.localeCompare(b.key));
}

afterEach(() => vi.restoreAllMocks());

describe('Shared completed-turn streaming', () => {
  it.each([false, true])('preserves batch spans, complete inputs and token aggregates (delegated=%s)', async delegated => {
    const records = turn(40, delegated);
    const before = JSON.stringify(records);
    const expected = (await collect(records, true)).flat();
    const batches = await collect(records);
    const actual = batches.flat();
    expect(snapshot(actual)).toEqual(snapshot(expected));
    expect(JSON.stringify(records)).toBe(before);
    expect(actual).toHaveLength(delegated ? 121 : 122);
    expect(batches.length).toBeGreaterThan(1);
    expect(new Set(actual.map(s => s.spanContext().spanId)).size).toBe(actual.length);
    const agent = actual.find(s => s.attributes['gen_ai.span.kind'] === 'AGENT')!;
    expect(agent.attributes['gen_ai.usage.input_tokens']).toBe(4780);
    expect(agent.attributes['gen_ai.usage.output_tokens']).toBe(1180);
    expect(agent.attributes['gen_ai.usage.reasoning_tokens']).toBe(780);
    expect(agent.attributes['gen_ai.usage.cache_read.input_tokens']).toBe(40);
    expect(agent.attributes['gen_ai.usage.cache_creation.input_tokens']).toBe(80);
  });

  it.each(['claude-code', 'opencode', 'hermes', 'codex', 'qoder', 'qoder-cn', 'qwen-code-cli', 'grok-build', 'copilot', 'dsh', 'cursor'])(
    'preserves the %s adapter under bounded export batches', async agent => {
      const records = turn(40, false, agent);
      const before = JSON.stringify(records);
      const expected = (await collect(records, true)).flat();
      const planner = vi.spyOn(stream, 'planTurnStream');
      const actual = (await collect(records)).flat();
      expect(planner.mock.results.some(result => typeof result.value === 'function')).toBe(true);
      expect(snapshot(actual)).toEqual(snapshot(expected));
      expect(JSON.stringify(records)).toBe(before);
      expect(actual.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM')).toHaveLength(40);
    },
  );

  it.each([false, true])('preserves native Codex IDs and delegation on replay (delegated=%s)', async delegated => {
    const records = turn(40, delegated, 'codex').map(record => ({ ...record,
      'agent.codex.transcript_turn_id': 'native-turn',
      ...(delegated ? { 'agent.codex.delegated': true, 'agent.codex.parent_span_id': '1111111111111111' } : {}),
    }));
    const expected = (await collect(records, true)).flat();
    const actual = (await collect(records)).flat();
    expect(actual.map(span => span.spanContext().spanId).sort()).toEqual(expected.map(span => span.spanContext().spanId).sort());
    expect(snapshot(actual)).toEqual(snapshot(expected));
  });

  it('batches a short compatible turn once while draining SDK callbacks', async () => {
    const batches = await collect(turn(2, false, 'claude-code'), false, 1024 * 1024);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(8);
  });

  it('awaits each export without retaining completed steps behind a slow backend', async () => {
    let active = 0, peak = 0, count = 0;
    const flusher = new OtlpTraceFlusher({ enabled: true, protocol: 'http/protobuf', serviceName: 'slow-stream',
      maxExportBatchBytes: 5000,
      endpoints: [{ name: 'test', endpoint: 'http://127.0.0.1:4318' }] }, undefined,
      () => ({ export(spans, callback) {
        active++; peak = Math.max(peak, active); count += spans.length;
        setTimeout(() => { active--; callback({ code: 0 }); }, 1);
      }, shutdown: async () => {} }));
    try { await flusher.sendBatch(turn()); } finally { await flusher.shutdown(); }
    expect(peak).toBe(1);
    expect(count).toBe(122);
  });

  it('drains SDK completion callbacks even when the remote exporter completes synchronously', async () => {
    let pending = 0, peak = 0;
    const original = InMemorySpanExporter.prototype.export;
    vi.spyOn(InMemorySpanExporter.prototype, 'export').mockImplementation(function(spans, callback) {
      pending++; peak = Math.max(peak, pending);
      original.call(this, spans, result => { pending--; callback(result); });
    });
    await collect(turn(80));
    expect(peak).toBeLessThanOrEqual(8);
    expect(pending).toBe(0);
  });

  it('keeps batch handling for inline children and response order that the stream cannot preserve', async () => {
    const records = turn();
    const handler = {} as any;
    const response = records.splice(2, 1)[0];
    records.splice(records.length - 1, 0, response);
    expect(stream.planTurnStream(records, { handler, passthroughKeys: [] })).toBeUndefined();
    const inline = turn();
    inline[2] = { ...inline[2], 'gen_ai.agent.scope': 'subagent', 'gen_ai.subagent.parent_tool_call.id': 'tool-0' };
    expect(stream.planTurnStream(inline, { handler, passthroughKeys: [] })).toBeUndefined();
  });

  it('preflights missing steps, legacy multi-request steps and late parent metadata before emission', async () => {
    const missing = turn(); delete missing[1]['gen_ai.step.id'];
    const merged = turn();
    for (const record of merged) if (record['gen_ai.step.id'] === 'step_1') record['gen_ai.step.id'] = 'step_0';
    const lateIdentity = turn();
    for (const record of lateIdentity) if (record['gen_ai.step.id'] === 'step_0' || record['event.name'] === 'other') delete record['user.id'];
    const handler = {} as any;
    for (const records of [missing, merged, lateIdentity]) {
      expect(stream.planTurnStream(records, { handler, passthroughKeys: [] })).toBeUndefined();
      expect(snapshot((await collect(records)).flat())).toEqual(snapshot((await collect(records, true)).flat()));
    }
  });

  it('isolates a failed streamed batch and the following turn on every endpoint', async () => {
    const received = new Map<string, ReadableSpan[]>();
    let attempts = 0;
    let failedSpans = 0;
    const flusher = new OtlpTraceFlusher({ enabled: true, protocol: 'http/protobuf', serviceName: 'fanout-stream',
      maxExportBatchBytes: 5000,
      endpoints: [{ name: 'a', endpoint: 'http://127.0.0.1:4318' }, { name: 'b', endpoint: 'http://127.0.0.1:4319' }] }, undefined,
      ({ name }) => ({ export(spans, callback) {
        received.set(name, [...received.get(name) ?? [], ...spans]);
        const fail = name === 'a' && ++attempts === 4;
        if (fail) failedSpans += spans.length;
        callback(fail ? { code: 1, error: new Error('synthetic rejection') } : { code: 0 });
      }, shutdown: async () => {} }));
    const failed = vi.spyOn(flusher as any, 'writeFailedLog').mockResolvedValue(undefined);
    const next = turn(2).map(r => ({ ...r, trace_id: 'abcdef1234567890abcdef1234567890', 'gen_ai.turn.id': 'next-turn' }));
    try {
      await flusher.sendBatch(turn());
      await flusher.sendBatch(next);
    } finally { await flusher.shutdown(); }
    expect(failed).toHaveBeenCalledTimes(1);
    for (const spans of received.values()) {
      expect(spans).toHaveLength(130);
      expect(new Set(spans.map(s => `${s.spanContext().traceId}:${s.spanContext().spanId}`)).size).toBe(130);
      const agent = spans.find(s => s.attributes['gen_ai.span.kind'] === 'AGENT'
        && s.spanContext().traceId === 'abcdef1234567890abcdef1234567890')!;
      expect(agent.attributes['gen_ai.usage.input_tokens']).toBe(201);
      expect(agent.attributes['gen_ai.usage.reasoning_tokens']).toBe(1);
    }
    expect(failedSpans).toBeGreaterThan(0);
    expect(flusher.getEndpointCounters().get('a')?.outFailed).toBe(failedSpans);
    expect(flusher.getEndpointCounters().get('b')?.outFailed).toBe(0);
  });

  it('backpressures repeated export failures through failed-log persistence', async () => {
    let active = 0, peak = 0, persisted = 0;
    const flusher = new OtlpTraceFlusher({ enabled: true, protocol: 'http/protobuf', serviceName: 'failed-stream',
      maxExportBatchBytes: 5000, endpoints: [{ name: 'failed', endpoint: 'http://127.0.0.1:4318' }] }, undefined,
      () => ({ export(_spans, callback) { callback({ code: 1, error: new Error('synthetic unavailable') }); }, shutdown: async () => {} }));
    vi.spyOn(flusher as any, 'writeFailedLog').mockImplementation(async (...args: any[]) => {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 2));
      persisted += args[2].length;
      active--;
    });
    try { await flusher.sendBatch(turn(40, false, 'claude-code')); } finally { await flusher.shutdown(); }
    expect(peak).toBe(1);
    expect(active).toBe(0);
    expect(persisted).toBe(122);
  });

  it('flush waits for a completed turn already exporting through sendBatch', async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const received: ReadableSpan[] = [];
    const flusher = new OtlpTraceFlusher({ enabled: true, protocol: 'http/protobuf', serviceName: 'flush-stream',
      endpoints: [{ endpoint: 'http://127.0.0.1:4318' }] }, undefined, () => ({
      export(spans, callback) {
        entered();
        void barrier.then(() => { received.push(...spans); callback({ code: 0 }); });
      }, shutdown: async () => {},
    }));
    const sending = flusher.sendBatch(turn(2));
    await started;
    let flushed = false;
    const flushing = flusher.flush().then(() => { flushed = true; });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(flushed).toBe(false);
    release();
    await Promise.all([sending, flushing]);
    expect(received).toHaveLength(8);
    await flusher.shutdown();
  });
});
