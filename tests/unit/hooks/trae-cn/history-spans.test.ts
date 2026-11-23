import { expect, it } from 'vitest';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import type { AgentActivityEntry } from '../../../../src/types/index.js';
import { expandTraeHistory } from '../../../../src/flushers/trae-cn-history-spans.js';

it('keeps response identities distinct and turn-level data on the agent', () => {
  const span = (kind: string, id: string, parent?: string): ReadableSpan => ({
    spanContext: () => ({ spanId: id, traceId: 'a'.repeat(32) }), parentSpanId: parent,
    attributes: { 'gen_ai.span.kind': kind }, name: kind,
  }) as ReadableSpan;
  const agent = span('AGENT', '1'), step = span('STEP', '2', '1');
  const llm = span('LLM', '3', '2'), tool = span('TOOL', '4', '2');
  Object.assign(tool, { startTime: [1700000010, 0], endTime: [1700000011, 5] });
  tool.attributes['gen_ai.tool.call.id'] = 'call_a';
  llm.attributes['gen_ai.usage.total_tokens'] = 51;
  llm.attributes['gen_ai.input.messages'] = 'user prompt';
  llm.attributes['gen_ai.output.messages'] = JSON.stringify([{ role: 'assistant', parts: [
    { type: 'tool_call', id: 'call_a' }, { type: 'text', content: 'final answer' },
  ] }]);
  tool.attributes['gen_ai.tool.call.result'] = 'tool result';
  const rounds = ['a', 'b', 'c'].map((c, i) => ({ id: c.repeat(24), initial: i === 0, terminal: i === 2, request: c, continuation: i === 2 ? 'b' : undefined, ...(i === 1 ? { toolIds: ['call_a'], input: 30, output: 2, cached: 10 } : {}), at: String(1700000000000000100n + BigInt(i) * 10000000000n) }));
  const records = [{ 'event.name': 'llm.response', span_id: '3', 'loongsuite.trae_cn.model_responses': rounds }] as unknown as AgentActivityEntry[];
  const result = expandTraeHistory(records, [agent, step, llm, tool]);
  const models = result.filter(s => s.attributes['gen_ai.span.kind'] === 'LLM');
  expect(models.map(s => s.attributes['gen_ai.response.id'])).toEqual(rounds.map(r => r.id));
  expect(new Set(models.map(s => s.parentSpanId)).size).toBe(3);
  expect(models.map(s => s.attributes['gen_ai.usage.total_tokens'])).toEqual([undefined, 32, undefined]);
  expect(agent.attributes['gen_ai.usage.total_tokens']).toBe(51);
  expect(tool.parentSpanId).toBe(models[1].parentSpanId);
  expect(models[1].startTime).toEqual([1700000010, 100]);
  const owner = result.find(s => s.spanContext().spanId === tool.parentSpanId);
  expect(owner?.startTime).toEqual(tool.startTime);
  expect(owner?.endTime).toEqual(tool.endTime);
  expect(owner?.duration).toEqual([1, 5]);
  expect(models.map(s => s.attributes['gen_ai.input.messages'])).toEqual(['user prompt', undefined,
    JSON.stringify([{ role: 'tool', parts: [{ type: 'tool_call_response', id: 'call_a', response: 'tool result' }] }])]);
  expect(models.map(s => s.attributes['gen_ai.output.messages'])).toEqual([undefined,
    JSON.stringify([{ role: 'assistant', parts: [{ type: 'tool_call', id: 'call_a' }] }]),
    JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: 'final answer' }] }])]);
  expect(result).toHaveLength(8);
});

it('retains shared input, observed usage and tool ownership once per response stream', () => {
  const span = (kind: string, id: string, parent?: string) => ({
    spanContext: () => ({ spanId: id, traceId: 'a'.repeat(32) }), parentSpanId: parent,
    startTime: [1, 0], endTime: [4, 0], attributes: { 'gen_ai.span.kind': kind },
  }) as unknown as ReadableSpan;
  const agent = span('AGENT', '1'), step = span('STEP', '2', '1');
  const llm = span('LLM', '3', '2'), tool = span('TOOL', '4', '2');
  llm.attributes['gen_ai.input.messages'] = 'shared prompt';
  tool.attributes['gen_ai.tool.call.id'] = 'call_one';
  const rounds = ['a', 'b'].map((c, i) => ({ id: c.repeat(24), at: String((i + 2) * 1e9),
    shared: true, initial: true, request: 'stream', toolIds: ['call_one'], streamReceived: 2,
    streamExpected: 2, streamTokens: 30 }));
  const records = [{ 'event.name': 'llm.response', span_id: '3', 'loongsuite.trae_cn.model_responses': rounds }] as unknown as AgentActivityEntry[];
  const spans = expandTraeHistory(records, [agent, step, llm, tool]);
  const steps = spans.filter(s => s.attributes['gen_ai.span.kind'] === 'STEP');
  expect(steps).toHaveLength(1);
  expect(steps[0].attributes['gen_ai.input.messages']).toBe('shared prompt');
  expect(steps[0].attributes['agent.trae-cn.hub.total_tokens_observed']).toBe(30);
  const models = spans.filter(s => s.attributes['gen_ai.span.kind'] === 'LLM');
  expect(models.map(m => m.attributes['gen_ai.response.id'])).toEqual(rounds.map(r => r.id));
  expect([...models, tool].every(s => s.parentSpanId === steps[0].spanContext().spanId)).toBe(true);
  expect(models.every(s => s.attributes['gen_ai.usage.total_tokens'] === undefined)).toBe(true);
});
