import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import cbor from 'cbor';
import { expect, it } from 'vitest';
import { HubUsage } from '../../../../src/inputs/trae-cn-log/hub-usage.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';
import { NativeUsageIndex } from '../../../../src/inputs/trae-cn-log/native-usage-index.js';

it.each(['valid', 'rotated', 'deleted', 'expired', 'overlap', 'wrong count', 'two histories', 'two replies'])('reconciles a native tool batch: %s', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'trae-stream-'));
  const index = new NativeUsageIndex();
  Object.assign(index, { root });
  const session = '1'.repeat(24), turn = '2'.repeat(24), history = '3'.repeat(24), reply = '4'.repeat(24);
  const unrelatedReply = '6'.repeat(24);
  const chunks: Buffer[] = [];
  function add(message: string, fields: Record<string, string | number | boolean>) {
    const data = { trace_id: 'a'.repeat(32), message, ...fields };
    chunks.push(cbor.encode({ span: 42, time: [2026, 320, 8, 3, 2, chunks.length, 0, 0, 0], fields:
      Object.fromEntries(Object.entries(data).map(([k,v]) => [k, typeof v === 'string' ? Buffer.from(v) : v])) }));
  }
  const open = (request: string) => add('cloud stream response headers',
    { url: 'https://example.org/api/agent/v3/create_agent_task', resp_logid: request });
  const record = (id: string) => add('recording history entry', { history_id: id, history_source: 'Server', source: 'llm_default' });
  add('context resolve applied to task request', { session_id: session, turn_id: turn });
  open('request1');
  if (mode === 'overlap') open('request2');
  record(history);
  if (mode === 'two histories') record('5'.repeat(24));
  add('[Hub] task event contract', { event_type: 'token_usage', conversation_id: session, task_id: reply, event_seq: 5 });
  for (const toolcall_id of ['one','two']) {
    add('streaming ToolCall dispatch', { require_local_execution: true, toolcall_id });
    add('tool execution started', { toolcall_id, tool_name: toolcall_id === 'two' ? 'TodoWrite' : 'Read' });
  }
  add('routing CommitReady', { has_async_child: false, has_foreground: false, parent_result_count: 2 });
  add('commit_results', { conversation_id: session, result_count: mode === 'wrong count' ? 1 : 2 });
  if (mode === 'two replies') {
    add('cloud stream response headers', {
      url: 'https://example.org/api/agent/v3/commit_toolcall_result', resp_logid: 'request2',
    });
    add('[Hub] task event contract', {
      event_type: 'token_usage', conversation_id: session, task_id: unrelatedReply, event_seq: 9,
    });
    add('resolving explicit Cloud task completion as terminal', {});
  }
  add('chat: runner completed', { turn_id: turn });
  const header = Buffer.alloc(178);
  header.write('AalG'); header.write('AALG',152);header.writeUInt32LE(6,168);
  try {
    const dir = join(root, '20261120T150000', 'Modular');
    await mkdir(dir, { recursive: true });
    const rotated = ['rotated', 'deleted', 'expired'].includes(mode);
    const oldFile = join(dir, 'ai_agent-0-2026-11-20.alaudalog');
    const segment = (records: Buffer[]) => Buffer.concat([header, deflateRawSync(Buffer.concat(records))]);
    await writeFile(oldFile, segment(rotated ? chunks.slice(0, -3) : chunks));
    if (mode === 'deleted' || mode === 'expired') {
      await index.refresh();
      if (mode === 'deleted') await rm(oldFile);
      if (mode === 'expired') {
        const stale = new Date(Date.now() - 2 * 3600_000);
        await utimes(oldFile, stale, stale);
      }
      await index.refresh(); // Evict the predecessor before reading the continuation.
    }
    if (rotated) await writeFile(join(dir, 'ai_agent-1-2026-11-20.alaudalog'), segment(chunks.slice(-3)));
    await index.refresh();
    const calls = new Set(['one']);
    const trace = 'a'.repeat(32);
    const evidence = index.responses(session, calls, { trace, reply });
    const rounds = evidence?.rounds;
    expect(rounds?.[0].id).toBe(history);
    expect(evidence?.matchesHubOwner).toBe(true);
    expect(index.responses(session, calls, { trace: 'f'.repeat(32), reply })?.matchesHubOwner).toBe(false);
    expect(index.responses(session, calls, { trace, reply: '9'.repeat(24) })?.matchesHubOwner).toBe(false);
    if (mode === 'two replies') {
      expect(index.ownsTool(trace, session, reply, calls)).toBe(true);
      expect(index.ownsTool(trace, session, unrelatedReply, calls)).toBe(false);
    }
    if (rotated) {
      expect(index.ownsTool(trace, session, reply, calls)).toBe(true);
      expect(index.expectedSeqs(trace, session, reply)).toEqual(new Set([5]));
      expect(index.complete(trace, session, reply, new Map([[5, 42]]))).toBe(true);
      expect(rounds?.[0]).toMatchObject({ id: history, reply, seq: 5, todos: [{ call: 'two' }] });
      const hubDir = join(root, 'hub');
      await mkdir(join(hubDir, 'task'), { recursive: true });
      const hub = new HubUsage(hubDir);
      try {
        const rows = [
          { seq: 1, type: 'metadata', data: { session_id: session, trace_id: trace } },
          { seq: 5, type: 'token_usage', data: { prompt_tokens: 40, completion_tokens: 2, total_tokens: 42 } },
        ];
        await writeFile(join(hubDir, 'task', reply + '.jsonl'), rows.map(row => JSON.stringify({
          ...row, data: JSON.stringify({ ...row.data, reply_to_message_id: reply }),
        })).join('\n') + '\n');
        await hub.refresh();
        const entry = { 'event.name': 'llm.response', 'gen_ai.session.id': session,
          'agent.trae-cn.tool_call_ids': ['one'] } as unknown as AgentActivityEntry;
        hub.enrich(entry, index);
        expect(entry['gen_ai.usage.total_tokens']).toBe(42);
        expect(entry['loongsuite.trae_cn.model_responses']).toMatchObject([{ id: history, input: 40, output: 2 }]);
      } finally { await hub.close(); }
    }
    if (mode === 'valid' || rotated || mode === 'two replies') expect(rounds?.[0]).toMatchObject({ request: 'request1', headersAt: String(BigInt(Date.UTC(2026, 0, 320, 8, 3, 2)) * 1000000n + 1n), reply, seq: 5, toolIds: ['one','two'] });
    else if (mode === 'two histories') {
      expect(rounds).toHaveLength(2);
      for (const round of rounds!) {
        expect(round).toMatchObject({ shared: true, initial: true, request: 'request1', streamReports: [{ reply, seq: 5 }] });
        expect(round).not.toHaveProperty('seq');
        expect(round).not.toHaveProperty('headersAt');
      }
    } else expect(rounds?.[0]).not.toHaveProperty('request');
  } finally {
    index.close();
    await rm(root, { recursive: true, force: true });
  }
});
