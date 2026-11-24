import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import cbor from 'cbor';
import { expect, it } from 'vitest';
import { NativeUsageIndex } from '../../../../src/inputs/trae-cn-log/native-usage-index.js';

it.each(['valid', 'rotated', 'overlap', 'wrong count', 'two histories', 'two replies'])('reconciles a native tool batch: %s', async mode => {
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
    add('tool execution started', { toolcall_id });
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
    await writeFile(join(dir, 'ai_agent-0-2026-11-20.alaudalog'), Buffer.concat([header,deflateRawSync(Buffer.concat(mode === 'rotated' ? chunks.slice(0, -3) : chunks))]));
    if (mode === 'rotated') await writeFile(join(dir, 'ai_agent-1-2026-11-20.alaudalog'),
      Buffer.concat([header, deflateRawSync(Buffer.concat(chunks.slice(-3)))]));
    await index.refresh();
    const rounds = index.responses(session, new Set(['one']));
    expect(rounds?.[0].id).toBe(history);
    if (mode === 'two replies') {
      const trace = 'a'.repeat(32);
      const calls = new Set(['one']);
      expect(index.ownsTool(trace, session, reply, calls)).toBe(true);
      expect(index.ownsTool(trace, session, unrelatedReply, calls)).toBe(false);
    }
    if (mode === 'valid' || mode === 'rotated' || mode === 'two replies') expect(rounds?.[0]).toMatchObject({ request: 'request1', headersAt: String(BigInt(Date.UTC(2026, 0, 320, 8, 3, 2)) * 1000000n + 1n), reply, seq: 5, toolIds: ['one','two'] });
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
