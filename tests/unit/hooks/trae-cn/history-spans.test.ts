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
  tool.attributes['gen_ai.tool.call.id'] = 'call_a';
  llm.attributes['gen_ai.usage.total_tokens'] = 51;
  llm.attributes['gen_ai.input.messages'] = 'user prompt';
  llm.attributes['gen_ai.output.messages'] = JSON.stringify([{ role: 'assistant', parts: [
    { type: 'tool_call', id: 'call_a' }, { type: 'text', content: 'final answer' },
  ] }]);
  tool.attributes['gen_ai.tool.call.result'] = 'tool result';
  const rounds = ['a', 'b', 'c'].map((c, i) => ({ id: c.repeat(24), initial: i === 0, terminal: i === 2, request: c, continuation: i === 2 ? 'b' : undefined, ...(i === 1 ? { toolIds: ['call_a'], input: 30, output: 2, cached: 10 } : {}), at: String(1700000000000000000n + BigInt(i)) }));
  const records = [{ 'event.name': 'llm.response', span_id: '3', 'loongsuite.trae_cn.model_responses': rounds }] as unknown as AgentActivityEntry[];
  const result = expandTraeHistory(records, [agent, step, llm, tool]);
  const models = result.filter(s => s.attributes['gen_ai.span.kind'] === 'LLM');
  expect(models.map(s => s.attributes['gen_ai.response.id'])).toEqual(rounds.map(r => r.id));
  expect(new Set(models.map(s => s.parentSpanId)).size).toBe(3);
  expect(models.map(s => s.attributes['gen_ai.usage.total_tokens'])).toEqual([undefined, 32, undefined]);
  expect(agent.attributes['gen_ai.usage.total_tokens']).toBe(51);
  expect(tool.parentSpanId).toBe(models[1].parentSpanId);
  expect(models.map(s => s.attributes['gen_ai.input.messages'])).toEqual(['user prompt', undefined,
    JSON.stringify([{ role: 'tool', parts: [{ type: 'tool_call_response', id: 'call_a', response: 'tool result' }] }])]);
  expect(models.map(s => s.attributes['gen_ai.output.messages'])).toEqual([undefined,
    JSON.stringify([{ role: 'assistant', parts: [{ type: 'tool_call', id: 'call_a' }] }]),
    JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: 'final answer' }] }])]);
  expect(result).toHaveLength(8);
});
