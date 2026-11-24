import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { HubUsage } from '../../../../src/inputs/trae-cn-log/hub-usage.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';

it.each([true, false])('joins cache counts by call ID, with continuous stream=%s', async complete => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-trae-hub-'));
  const hub = new HubUsage(root, complete);
  const reply = '1'.repeat(24), session = '2'.repeat(24);
  const event = (seq: number, type: string, data: Record<string, unknown>) => JSON.stringify({
    seq, type, data: JSON.stringify({ reply_to_message_id: reply, ...data }),
  });
  const response = (id: string) => ({
    'event.name': 'llm.response', 'gen_ai.session.id': session,
    'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'tool_call', id }] }],
  }) as AgentActivityEntry;
  try {
    await mkdir(join(root, 'task'));
    const file = join(root, 'task', reply + '.jsonl');
    await writeFile(file, [
      event(1, 'metadata', { session_id: session, trace_id: 'a'.repeat(32) }),
      event(2, 'plan_item', { id: 'pi_one', reasoning_content: 'check the title', tool_call_info: { meta: { llm_toolcall_id: 'call_example' } } }),
      event(3, 'token_usage', { reasoning_tokens: 1, cache_creation_input_tokens: 0, prompt_tokens: 300, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 100 }, total_tokens: 302 }),
      event(4, 'token_usage', { reasoning_tokens: 2, cache_creation_input_tokens: 0, prompt_tokens: 100, completion_tokens: 3, cache_read_input_tokens: 0, prompt_tokens_details: { cached_tokens: 77 }, total_tokens: 103 }),
      event(5, 'plan_item', { id: 'pi_one', reasoning_content: 'check the title again' }),
      event(complete ? 6 : 8, 'done', {}),
    ].join('\n') + '\n');
    await hub.refresh();
    await rm(file);
    await hub.refresh();
    const e = response('call_example');
    hub.enrich(e);
    const reasoning = JSON.stringify(e['gen_ai.output.messages']);
    expect(reasoning.includes('check the title again')).toBe(complete);
    expect(reasoning.match(/check the title/g)?.length ?? 0).toBe(complete ? 1 : 0);
    if (complete) expect(reasoning).toContain('"tool_call_id":"call_example"');
    expect(e['agent.trae-cn.hub.cache_hit_ratio_observed']).toBe(0.25);
    expect(e['gen_ai.usage.reasoning_tokens']).toBe(complete ? 3 : undefined);
    expect(e['gen_ai.usage.cache_creation.input_tokens']).toBe(complete ? 0 : undefined);
    expect(e['gen_ai.usage.total_tokens']).toBe(complete ? 405 : undefined);
    const withoutContent = {
      'event.name': 'llm.response',
      'gen_ai.session.id': session,
      'agent.trae-cn.tool_call_ids': ['call_example'],
    } as AgentActivityEntry;
    hub.enrich(withoutContent);
    expect(withoutContent['agent.trae-cn.hub.total_tokens_observed']).toBe(405);
    expect(withoutContent['gen_ai.usage.total_tokens']).toBe(complete ? 405 : undefined);
    expect(withoutContent['gen_ai.output.messages']).toBeUndefined();
    expect(withoutContent['agent.trae-cn.tool_call_ids']).toBeUndefined();
    const partialHook = response('call_example');
    partialHook['gen_ai.usage.input_tokens'] = 400;
    hub.enrich(partialHook);
    expect(partialHook['gen_ai.usage.cache_read.input_tokens']).toBe(complete ? 100 : undefined);
    const conflictingHook = response('call_example');
    conflictingHook['gen_ai.usage.input_tokens'] = 300;
    hub.enrich(conflictingHook);
    expect(conflictingHook['gen_ai.usage.cache_read.input_tokens']).toBeUndefined();
    const other = response('different');
    hub.enrich(other);
    expect(other['agent.trae-cn.hub.trace_id']).toBeUndefined();
  } finally {
    await hub.close();
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  { capture: false, matchesHubOwner: true },
  { capture: true, matchesHubOwner: true },
  { capture: true, matchesHubOwner: false },
])('joins TodoWrite bodies with capture=$capture and matching Hub owner=$matchesHubOwner', async ({ capture, matchesHubOwner }) => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-trae-todo-'));
  const hub = new HubUsage(root, capture);
  const reply = '1'.repeat(24), session = '2'.repeat(24);
  const args = { todos: [{ id: 'task', status: 'pending' }] };
  const result = { todo_list: args };
  try {
    await mkdir(join(root, 'task'));
    const rows = [
      ['metadata', { session_id: session, trace_id: 'a'.repeat(32) }],
      ['plan_item', { id: 'read', tool_call_info: { meta: { llm_toolcall_id: 'read-call' } } }],
      ['plan_item', { id: 'todo', tool_call_info: { name: 'TodoWrite', params: args,
        result: { status: 'success', data: result }, meta: { llm_toolcall_id: 'todo-call' } } }],
      ['plan_item', { id: 'todo', tool_call_info: { name: 'TodoWrite', params: args,
        result: { status: 'success', data: { ...result, result: 'UI summary' } }, meta: { llm_toolcall_id: 'todo-call' } } }],
    ] as const;
    await writeFile(join(root, 'task', reply + '.jsonl'), rows.map(([type, data], seq) =>
      JSON.stringify({ type, seq, data: JSON.stringify({ ...data, reply_to_message_id: reply }) })).join('\n') + '\n');
    await hub.refresh();
    const entry = { 'event.name': 'llm.response', trace_id: 'a'.repeat(32), parent_span_id: '1'.repeat(16),
      'gen_ai.session.id': session, 'agent.trae-cn.tool_call_ids': ['read-call'],
      'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content: 'Final answer' }] }],
    } as unknown as AgentActivityEntry;
    const events = hub.enrich(entry, { expectedSeqs: () => undefined, complete: () => false,
      responses: () => ({ matchesHubOwner, rounds: [
        { id: '3'.repeat(24), at: '100', todos: [{ call: 'todo-call', start: '102', committedAt: '105' }] },
      ] }) });
    expect(events?.map(e => e['gen_ai.tool.call.id'])).toEqual(['todo-call', 'todo-call']);
    const includesBody = capture && matchesHubOwner;
    expect(events?.[0]['gen_ai.tool.call.arguments']).toEqual(includesBody ? args : undefined);
    expect(events?.[1]['gen_ai.tool.call.result']).toEqual(includesBody ? result : undefined);
    const answer = { role: 'assistant', parts: [{ type: 'text', content: 'Final answer' }] };
    expect(entry['gen_ai.output.messages']).toEqual(capture ? [
      { role: 'assistant', parts: [expect.objectContaining({ type: 'tool_call', id: 'todo-call' })] }, answer,
    ] : [answer]);
  } finally {
    await hub.close();
    await rm(root, { recursive: true, force: true });
  }
});
