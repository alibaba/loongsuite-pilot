import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { HubUsage } from '../../../../src/inputs/trae-cn-log/hub-usage.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';

it.each([true, false])('joins cache counts by call ID, with continuous stream=%s', async complete => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-trae-hub-'));
  const hub = new HubUsage(root);
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
      event(2, 'plan_item', { tool_call_info: { meta: { llm_toolcall_id: 'call_example' } } }),
      event(3, 'token_usage', { prompt_tokens: 300, completion_tokens: 2, cache_read_input_tokens: 100, total_tokens: 302 }),
      event(4, 'token_usage', { prompt_tokens: 100, completion_tokens: 3, cache_read_input_tokens: 0, total_tokens: 103 }),
      event(complete ? 5 : 7, 'done', {}),
    ].join('\n') + '\n');
    await hub.refresh();
    await rm(file);
    await hub.refresh();
    const e = response('call_example');
    hub.enrich(e);
    expect(e['agent.trae-cn.hub.cache_hit_ratio_observed']).toBe(0.25);
    expect(e['gen_ai.usage.total_tokens']).toBe(complete ? 405 : undefined);
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
