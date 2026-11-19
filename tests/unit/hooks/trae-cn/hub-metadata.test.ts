import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HubMetadata } from '../../../../src/inputs/trae-cn-log/hub-metadata.js';

it('retains only correlated timing metadata across partial writes and cache deletion', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'trae-hub-'));
  const reply = '1'.repeat(24), session = '2'.repeat(24), turn = '3'.repeat(24), trace = '4'.repeat(32);
  const line = (type: string, fields: object) => JSON.stringify({ type, data: JSON.stringify({
    reply_to_message_id: reply, ...fields,
  }) }) + '\n';
  const timing = { logid: 'request-1', model_name: 'model-4.1', data: {
    rs_17_before_request_llm: 1000, rs_18_llm_response_first_token: 1030,
  } };
  const tool = { agent_run_id: 'agent-A', tool_call_info: {
    name: 'Shell', meta: { llm_toolcall_id: 'call-A' }, params: 'private-command', result: 'private-output',
  }, timing: { tool_call_started_at_ms: 1150, tool_call_finished_at_ms: 1220 } };
  try {
    const dir = path.join(root, 'workspace');
    await mkdir(dir);
    const file = path.join(dir, reply + '.jsonl');
    const hub = new HubMetadata(root);
    const record = line('plan_item', tool);
    await writeFile(file, line('metadata', { trace_id: trace, turn_id: turn, session_id: session, query: 'private-prompt' }) +
      line('timing_events', timing) + line('timing_events', timing) +
      line('plan_item', { ...tool, reply_to_message_id: '5'.repeat(24) }) + record.slice(0, 50));
    await hub.scan();
    expect(hub.get(trace, turn, session)?.tools.size).toBe(0);
    await appendFile(file, record.slice(50));
    await hub.scan();
    await rm(file);
    await hub.scan();
    const observed = hub.get(trace, turn, session)!;
    expect(hub.get(trace, turn, reply)).toBeUndefined();
    expect([...observed.models.entries()]).toEqual([['request-1', { model: 'model-4.1', start: 1000, first: 1030 }]]);
    expect([...observed.tools.entries()]).toEqual([['call-A', { name: 'Shell', run: 'agent-A', start: 1150, end: 1220 }]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
