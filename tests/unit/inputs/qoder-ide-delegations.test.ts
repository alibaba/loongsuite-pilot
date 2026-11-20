import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { QoderIdeDelegations, QODER_NATIVE_SOURCE, readIdeDelegation, type IdeDelegation } from '../../../src/inputs/qoder-trace/ide-delegations.js';
import { NativeToolRowReader, type NativeToolCursor } from '../../../src/inputs/qoder-trace/native-tool-rows.js';
import { loadDatabaseSync } from '../../../src/utils/node-sqlite.js';
import * as sqliteTokenReader from '../../../src/inputs/qoder-trace/sqlite-token-reader.js';

let root: string;
const epoch = Date.now() - 60000;
const at = (ms: number) => new Date(epoch + ms).toISOString();
const secret = 'synthetic-private-prompt';
const nativeCall = (call: string, name = 'Read', input: object = { file_path: 'fixture.txt' }) => ({
  type: 'assistant', sessionId: 'child', timestamp: at(200),
  message: { role: 'assistant', content: [{ type: 'tool_use', id: call, name, input }] },
});
const nativeResult = (call: string, content = 'synthetic-file-result') => ({ type: 'user', sessionId: 'child', timestamp: at(250),
  toolUseResult: content,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: call, content }] } });
function detail(request = 'request-1', tool = 'read-1', session = 'child'): IdeDelegation {
  return { session, request, messages: [
    { id: `user-${request}`, role: 'user', gmt_create: epoch + 100 },
    { id: `model-${request}-1`, role: 'assistant', gmt_create: epoch + 200 },
    { id: `tool-${request}`, role: 'tool', gmt_create: epoch + 250, tool_call_id: tool },
    { id: `model-${request}-2`, role: 'assistant', gmt_create: epoch + 300 },
  ], tokens: [1, 2].map(i => ({ messageId: `model-${request}-${i}`, gmtCreate: epoch + (i === 1 ? 200 : 300),
    inputTokens: i * 100, outputTokens: i * 10, cacheReadTokens: i * 20, model: 'native-child-model' })) };
}
async function parent(call = 'delegate-1', options: Record<string, unknown> = {}) {
  const file = path.join(root, 'parent.jsonl');
  const records: Record<string, any>[] = ['tool.call', 'tool.result'].map((name, i) => ({
    'event.name': name, 'event.id': `${call}-${i}`, 'gen_ai.agent.type': 'qoder',
    'gen_ai.session.id': 'parent', 'gen_ai.turn.id': 'parent-turn', trace_id: 'a'.repeat(32),
    'gen_ai.step.id': `step-${call}`, 'gen_ai.tool.name': 'Agent', 'gen_ai.tool.call.id': call,
    ...(i === 0 ? { 'gen_ai.tool.call.arguments': { prompt: secret, subagent_type: 'reader', ...options } }
      : { 'gen_ai.tool.call.result': 'delivered-native-result', 'tool.result.status': 'success' }),
    'agent.qoder.cwd': root, time_unix_nano: String(BigInt(epoch + (i === 0 ? 50 : 400)) * 1000000n),
  }));
  for (const record of records) Object.defineProperty(record, QODER_NATIVE_SOURCE, { value: file });
  const native = [
    { ...nativeCall(call, 'Agent', records[0]!['gen_ai.tool.call.arguments']), sessionId: 'parent' },
    { ...nativeResult(call, 'delivered-native-result'), sessionId: 'parent' },
  ];
  await fs.appendFile(file, native.map(row => JSON.stringify(row)).join('\n') + '\n');
  return records;
}
async function child(rows = [nativeCall('read-1'), nativeResult('read-1')], session = 'child') {
  await fs.writeFile(path.join(root, `${session}.jsonl`), rows.map(row => JSON.stringify({ ...row, sessionId: session })).join('\n') + '\n');
}
beforeEach(async () => {
  root = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'qoder-ide-delegations-')), 'transcript');
  await fs.mkdir(root); await child();
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(path.dirname(root), { recursive: true, force: true }); });

describe('Qoder IDE native request delegation', () => {
  it('emits known invocation and result on message limit, warns once, and recovers after restart', async () => {
    const Database = loadDatabaseSync(); if (!Database) throw new Error('node:sqlite required');
    const dbPath = path.join(path.dirname(root), 'limit.db'); const db = new Database(dbPath);
    try {
      db.exec(`CREATE TABLE chat_record (session_id TEXT, request_id TEXT, parent_session_id TEXT, parent_tool_call_id TEXT, extra TEXT);
        CREATE TABLE chat_message (id TEXT, role TEXT, gmt_create INTEGER, token_info TEXT, model_info TEXT, tool_result TEXT, session_id TEXT, request_id TEXT)`);
      vi.spyOn(sqliteTokenReader, 'resolveAllQoderDbPaths').mockReturnValue([dbPath]);
      db.prepare('INSERT INTO chat_record VALUES (?, ?, ?, ?, ?)').run('child', 'request-1', 'parent', 'delegate-1', null);
      const insert = db.prepare('INSERT INTO chat_message VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      const put = (id: string, role: string, tool?: string) => insert.run(id, role, epoch + 200,
        role === 'assistant' ? JSON.stringify({ prompt_tokens: 10, completion_tokens: 2, cached_tokens: 1 }) : null,
        null, tool ? JSON.stringify({ toolCallId: tool }) : null, 'child', 'request-1');
      db.exec('BEGIN'); put('user', 'user'); put('model-1', 'assistant'); put('tool-1', 'tool', 'read-1');
      for (let i = 0; i < 4092; i++) put(`extra-${i}`, 'assistant');
      put('model-2', 'assistant'); db.exec('COMMIT');
      expect((await readIdeDelegation('parent', 'delegate-1'))?.messages).toHaveLength(4096);
      put('extra-late', 'assistant');
      let clock = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => clock);
      const warnings: string[] = []; const reader = new QoderIdeDelegations(undefined, reason => warnings.push(reason));
      const first = await reader.collect(await parent(), {});
      expect(first.records.map(row => row['event.name'])).toEqual(['gen_ai.agent.invoke', 'gen_ai.agent.result']);
      expect(warnings).toEqual(['ide-delegation-message-limit']);
      expect(Object.values(first.state)[0]!.diagnostic).toBe('message-limit');
      clock += 6000;
      expect((await reader.collect([], first.state)).records).toEqual([]);
      expect(warnings).toHaveLength(1);
      db.exec("DELETE FROM chat_message WHERE id LIKE 'extra-%'");
      const retry = await new QoderIdeDelegations().collect([], JSON.parse(JSON.stringify(first.state)));
      expect(retry.records.filter(row => row['event.name'] === 'llm.response')).toHaveLength(2);
      expect(retry.records.some(row => row['event.name'].startsWith('gen_ai.agent.'))).toBe(false);
      expect(Object.values(retry.state)[0]!.diagnostic).toBeUndefined();
      expect(JSON.stringify(retry.state)).not.toContain(secret);
    } finally { db.close(); }
  });

  it('reads one SQLite snapshot when messages are appended between pages', async () => {
    const Database = loadDatabaseSync(); if (!Database) throw new Error('node:sqlite required');
    const dbPath = path.join(path.dirname(root), 'snapshot.db'); const db = new Database(dbPath);
    try {
      db.exec(`PRAGMA journal_mode=WAL;
        CREATE TABLE chat_record (session_id TEXT, request_id TEXT, parent_session_id TEXT, parent_tool_call_id TEXT, extra TEXT);
        CREATE TABLE chat_message (id TEXT, role TEXT, gmt_create INTEGER, token_info TEXT, model_info TEXT, tool_result TEXT, session_id TEXT, request_id TEXT)`);
      vi.spyOn(sqliteTokenReader, 'resolveAllQoderDbPaths').mockReturnValue([dbPath]);
      db.prepare('INSERT INTO chat_record VALUES (?, ?, ?, ?, ?)').run('child', 'request-1', 'parent', 'delegate-1', null);
      const insert = db.prepare('INSERT INTO chat_message VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      const put = (id: string, role: string) => insert.run(id, role, epoch + 200, null, null, null, 'child', 'request-1');
      db.exec('BEGIN'); put('user', 'user'); for (let i = 0; i < 32; i++) put(`assistant-${i}`, 'assistant'); db.exec('COMMIT');
      setImmediate(() => put('late-assistant', 'assistant'));
      const snapshot = await readIdeDelegation('parent', 'delegate-1');
      expect(snapshot?.messages).toHaveLength(33);
      const next = await readIdeDelegation('parent', 'delegate-1');
      expect(next?.messages).toHaveLength(34);
      expect(next?.messages.at(-1)?.id).toBe('late-assistant');
    } finally { db.close(); }
  });

  it('reads a large native tool metadata ID without retaining its payload', async () => {
    const Database = loadDatabaseSync(); if (!Database) throw new Error('node:sqlite required');
    const dbPath = path.join(path.dirname(root), 'large-tool.db'); const db = new Database(dbPath);
    try {
      db.exec(`CREATE TABLE chat_record (session_id TEXT, request_id TEXT, parent_session_id TEXT, parent_tool_call_id TEXT, extra TEXT);
        CREATE TABLE chat_message (id TEXT, role TEXT, gmt_create INTEGER, token_info TEXT, model_info TEXT, tool_result TEXT, session_id TEXT, request_id TEXT)`);
      vi.spyOn(sqliteTokenReader, 'resolveAllQoderDbPaths').mockReturnValue([dbPath]);
      db.prepare('INSERT INTO chat_record VALUES (?, ?, ?, ?, ?)').run('child', 'request-1', 'parent', 'delegate-1', null);
      const insert = db.prepare('INSERT INTO chat_message VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      insert.run('user', 'user', epoch, null, null, null, 'child', 'request-1');
      insert.run('tool', 'tool', epoch + 1, null, null,
        JSON.stringify({ toolCallId: 'read-1', payload: 'synthetic-long-result-'.repeat(60000) }), 'child', 'request-1');
      const peer = await readIdeDelegation('parent', 'delegate-1');
      expect(peer?.complete).toBe(true);
      expect(peer?.messages[1]?.tool_call_id).toBe('read-1');
      expect(JSON.stringify(peer)).not.toContain('synthetic-long-result');
      db.prepare('UPDATE chat_message SET tool_result=? WHERE id=?').run(
        JSON.stringify({ toolCallId: 'read-1', payload: 'x'.repeat(17 * 1024 * 1024) }), 'tool');
      expect((await readIdeDelegation('parent', 'delegate-1'))?.diagnostic).toBe('tool-metadata-byte-limit');
      db.prepare('UPDATE chat_message SET tool_result=? WHERE id=?').run(JSON.stringify({ toolCallId: 'read-1' }), 'tool');
      expect((await readIdeDelegation('parent', 'delegate-1'))?.messages[1]?.tool_call_id).toBe('read-1');
      const payload = JSON.stringify({ toolCallId: 'read-extra', payload: 'x'.repeat(2 * 1024 * 1024) });
      db.exec('BEGIN');
      for (let i = 0; i < 9; i++) insert.run(`tool-extra-${i}`, 'tool', epoch + i + 2, null, null, payload, 'child', 'request-1');
      db.exec('COMMIT');
      expect((await readIdeDelegation('parent', 'delegate-1'))?.diagnostic).toBe('tool-metadata-total-byte-limit');
      db.exec("DELETE FROM chat_message WHERE id LIKE 'tool-extra-%'");
      expect((await readIdeDelegation('parent', 'delegate-1'))?.complete).toBe(true);
    } finally { db.close(); }
  });

  it('preserves the child session/turn, exact model usage and incoming identity on every child event', async () => {
    const input = await parent();
    const resolver = vi.fn(async () => detail());
    const batch = await new QoderIdeDelegations(resolver).collect(input, {});
    const invoke = batch.records.find(row => row['event.name'] === 'gen_ai.agent.invoke')!;
    const result = batch.records.find(row => row['event.name'] === 'gen_ai.agent.result')!;
    expect(invoke['gen_ai.agent.invocation.id']).toBe(result['gen_ai.agent.invocation.id']);
    expect(invoke['gen_ai.agent.peer.id']).toBe('child');
    const children = batch.records.filter(row => row['gen_ai.session.id'] === 'child');
    expect(children.length).toBeGreaterThan(0);
    expect(children.every(row => row['gen_ai.agent.id'] === 'child'
      && row['gen_ai.turn.id'] !== 'parent-turn'
      && row['gen_ai.agent.parent.invocation.id'] === invoke['gen_ai.agent.invocation.id']
      && row.parent_span_id === input[0]!.span_id)).toBe(true);
    const responses = children.filter(row => row['event.name'] === 'llm.response');
    expect(responses.map(row => row['gen_ai.response.id'])).toEqual(['model-request-1-1', 'model-request-1-2']);
    expect(responses.map(row => row['gen_ai.usage.input_tokens'])).toEqual([100, 200]);
    expect(responses[1]!['gen_ai.output.messages']).toEqual([{ role: 'assistant', parts: [{ type: 'text', content: 'delivered-native-result' }] }]);
    expect(responses[1]!['agent.source']).toBe('qoder-ide-agent-result');
    expect(responses[1]!['gen_ai.response.finish_reasons']).toBeUndefined();
    expect(JSON.stringify(batch.state)).not.toContain(secret);
    expect(JSON.stringify(batch.state)).not.toContain('synthetic-file-result');
    expect((await new QoderIdeDelegations(resolver).collect([], JSON.parse(JSON.stringify(batch.state)))).records).toEqual([]);
  });

  it('keeps reused native sessions separate by request and binds tools by exact call IDs', async () => {
    await child([nativeCall('read-1'), nativeResult('read-1'), nativeCall('read-2'), nativeResult('read-2')]);
    const input = [...await parent('delegate-1'), ...await parent('delegate-2')];
    const batch = await new QoderIdeDelegations(async (_session, call) => call === 'delegate-1' ? detail() : detail('request-2', 'read-2')).collect(input, {});
    const work = batch.records.filter(row => row['gen_ai.session.id'] === 'child');
    expect(new Set(work.map(row => row['gen_ai.turn.id'])).size).toBe(2);
    expect(new Set(work.map(row => row['gen_ai.agent.parent.invocation.id'])).size).toBe(2);
    expect(work.filter(row => row['event.name'] === 'tool.call').map(row => row['gen_ai.tool.call.id'])).toEqual(['read-1', 'read-2']);
    expect(new Set(batch.records.map(row => row['event.id'])).size).toBe(batch.records.length);
  });

  it('retries late SQLite metadata after a durable restart without repeating invocation logs', async () => {
    const input = await parent();
    const first = await new QoderIdeDelegations(async () => null).collect(input, {});
    expect(first.records).toEqual([]);
    const second = await new QoderIdeDelegations(async () => detail()).collect([], JSON.parse(JSON.stringify(first.state)));
    expect(second.records.length).toBeGreaterThan(0);
    const invoke = second.records.find(row => row['event.name'] === 'gen_ai.agent.invoke')!;
    expect(invoke['gen_ai.agent.invocation.id']).toBe(Object.keys(first.state)[0]);
    expect(second.records.filter(row => row['gen_ai.session.id'] === 'child')
      .every(row => row['gen_ai.agent.parent.invocation.id'] === invoke['gen_ai.agent.invocation.id'])).toBe(true);
  });

  it('rescans a completed transcript when a later SQLite snapshot adds a tool, including after restart', async () => {
    await child([nativeCall('read-1'), nativeResult('read-1'), nativeCall('read-2'), nativeResult('read-2')]);
    const partial = detail(); partial.messages.pop(); partial.tokens.pop();
    const first = await new QoderIdeDelegations(async () => partial).collect(await parent(), {});
    expect(first.records.filter(row => row['gen_ai.session.id'] === 'child')).toEqual([]);
    const full = detail();
    full.messages.splice(3, 0,
      { id: 'model-middle', role: 'assistant', gmt_create: epoch + 260 },
      { id: 'tool-middle', role: 'tool', gmt_create: epoch + 270, tool_call_id: 'read-2' });
    full.tokens.push({ messageId: 'model-middle', gmtCreate: epoch + 260,
      inputTokens: 10, outputTokens: 2, cacheReadTokens: 1, model: 'native-child-model' });
    const second = await new QoderIdeDelegations(async () => full).collect([], JSON.parse(JSON.stringify(first.state)));
    expect(second.records.filter(row => row['event.name'] === 'tool.call').map(row => row['gen_ai.tool.call.id']))
      .toEqual(['read-1', 'read-2']);
    expect(second.records.filter(row => row['event.name'] === 'llm.response')).toHaveLength(3);
  });

  it('advances past one 5 MiB native row and finds later tools across a persisted restart', async () => {
    await child([{ type: 'progress', data: { detail: 'x'.repeat(5 * 1024 * 1024) } },
      nativeCall('read-1'), nativeResult('read-1')] as any);
    const file = path.join(root, 'child.jsonl');
    let cursor: NativeToolCursor | undefined;
    let rows: Record<string, any>[] | null = null;
    let reader = new NativeToolRowReader();
    for (let i = 0; i < 6 && !rows; i++) {
      if (i === 1) reader = new NativeToolRowReader(); // Simulate loss of the in-memory partial line.
      const result = await reader.read(file, 'child', new Set(['read-1']), cursor,
        { remaining: 4 * 1024 * 1024 });
      cursor = JSON.parse(JSON.stringify(result.cursor));
      rows = result.rows;
    }
    expect(rows).not.toBeNull();
    expect(rows!.flatMap(row => row.message.content).map((block: any) => block.id ?? block.tool_use_id))
      .toEqual(['read-1', 'read-1']);
    expect(JSON.stringify(cursor)).not.toContain('x'.repeat(100));
  });

  it('resumes a large parent scan after the original input batch is gone', async () => {
    let clock = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const input = await parent(); const file = path.join(root, 'parent.jsonl');
    const original = await fs.readFile(file);
    await fs.writeFile(file, Buffer.concat([Buffer.from(JSON.stringify({ type: 'progress', data: { detail: 'x'.repeat(5 * 1024 * 1024) } }) + '\n'), original]));
    let result = await new QoderIdeDelegations(async () => detail()).collect(input, {});
    expect(result.records.filter(row => row['gen_ai.session.id'] === 'child')).toEqual([]);
    const reader = new QoderIdeDelegations(async () => detail());
    for (let i = 0; i < 6 && !result.records.some(row => row['gen_ai.session.id'] === 'child'); i++) {
      clock += 6000; result = await reader.collect([], JSON.parse(JSON.stringify(result.state)));
    }
    expect(result.records.filter(row => row['event.name'] === 'llm.response')).toHaveLength(2);
  });

  it('collects a matching 5 MiB tool result with bounded reads and a restart', async () => {
    const payload = '大'.repeat(2 * 1024 * 1024);
    await child([nativeCall('read-1'), nativeResult('read-1', payload)]);
    const file = path.join(root, 'child.jsonl');
    let cursor: NativeToolCursor | undefined;
    let rows: Record<string, any>[] | null = null;
    let reader = new NativeToolRowReader();
    for (let i = 0; i < 10 && !rows; i++) {
      if (i === 1) reader = new NativeToolRowReader();
      const budget = { remaining: 4 * 1024 * 1024 };
      const result = await reader.read(file, 'child', new Set(['read-1']), cursor, budget);
      expect(budget.remaining).toBeGreaterThanOrEqual(0);
      cursor = JSON.parse(JSON.stringify(result.cursor)); rows = result.rows;
    }
    expect(rows).not.toBeNull();
    expect(rows!.flatMap(row => row.message.content).find((block: any) => block.type === 'tool_result').content).toBe(payload);
    expect(JSON.stringify(cursor)).not.toContain('大');
  });

  it('waits for an incomplete UTF-8 row and resumes after an append and restart', async () => {
    const file = path.join(root, 'child.jsonl');
    const call = Buffer.from(JSON.stringify(nativeCall('read-1')) + '\n');
    const result = Buffer.from(JSON.stringify(nativeResult('read-1', '前后')) + '\n');
    const split = result.indexOf(Buffer.from('前')) + 1;
    await fs.writeFile(file, Buffer.concat([call, result.subarray(0, split)]));
    const first = await new NativeToolRowReader().read(file, 'child', new Set(['read-1']), undefined, { remaining: 1024 * 1024 });
    expect(first.rows).toBeNull();
    await fs.appendFile(file, result.subarray(split));
    const next = await new NativeToolRowReader().read(file, 'child', new Set(['read-1']),
      JSON.parse(JSON.stringify(first.cursor)), { remaining: 1024 * 1024 });
    expect(next.rows).not.toBeNull();
    expect(next.rows!.at(-1)!.message.content[0].content).toBe('前后');
  });

  it('keeps oversized unknown rows visibly incomplete while scanning subsequent rows', async () => {
    await child([{ type: 'progress', data: { detail: 'x'.repeat(17 * 1024 * 1024) } },
      nativeCall('read-1'), nativeResult('read-1')] as any);
    const file = path.join(root, 'child.jsonl'); const size = (await fs.stat(file)).size;
    let cursor: NativeToolCursor | undefined; const reader = new NativeToolRowReader();
    let rows: Record<string, any>[] | null = null;
    for (let i = 0; i < 8 && (cursor?.offset ?? 0) < size; i++) {
      const result = await reader.read(file, 'child', new Set(['read-1']), cursor, { remaining: 4 * 1024 * 1024 });
      cursor = JSON.parse(JSON.stringify(result.cursor)); rows = result.rows;
    }
    expect(cursor!.offset).toBe(size);
    expect(cursor!.blocked).toBe('line-byte-limit');
    expect(cursor!.matches['read-1']?.call).toBeDefined();
    expect(rows).toBeNull();
  });

  it('lets concurrent requests for the same transcript finish bounded scans and large range fetches', async () => {
    let clock = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => clock);
    await child([nativeCall('read-1'), nativeResult('read-1', 'a'.repeat(180000)),
      nativeCall('read-2'), nativeResult('read-2', 'b'.repeat(180000))]);
    const file = path.join(root, 'child.jsonl'); const reader = new NativeToolRowReader();
    const tasks = ['read-1', 'read-2'].map(id => ({ id, cursor: undefined as NativeToolCursor | undefined,
      rows: null as Record<string, any>[] | null }));
    for (let round = 0; round < 40 && tasks.some(task => !task.rows); round++) for (const task of tasks) {
      if (task.rows) continue;
      clock += 60_000; // Slow polling must not evict a live partial scan.
      const result = await reader.read(file, 'child', new Set([task.id]), task.cursor, { remaining: 128 * 1024 }, task.id);
      task.cursor = JSON.parse(JSON.stringify(result.cursor)); task.rows = result.rows;
    }
    for (const task of tasks) {
      expect(task.rows).not.toBeNull();
      expect(task.rows!.flatMap(row => row.message.content).map((block: any) => block.id ?? block.tool_use_id)).toEqual([task.id, task.id]);
    }
  });

  it('assigns parent TOOL IDs before the per-cycle delegation budget is reached', async () => {
    const input = (await Promise.all(Array.from({ length: 12 }, (_, i) => parent(`budget-${i}`)))).flat();
    const reader = new QoderIdeDelegations(async () => null);
    const first = await reader.collect(input, {});
    expect(Object.keys(first.state)).toHaveLength(12);
    for (let i = 0; i < input.length; i += 2) {
      expect(input[i]!.span_id).toMatch(/^[0-9a-f]{16}$/);
      expect(input[i + 1]!.span_id).toBe(input[i]!.span_id);
    }
  });

  it('keeps incoming and outgoing identities distinct for nested IDE work', async () => {
    await child([nativeCall('delegate-inner', 'Agent', { prompt: 'nested native input', subagent_type: 'reader' }), nativeResult('delegate-inner')]);
    await child([nativeCall('inner-read'), nativeResult('inner-read')], 'grandchild');
    const batch = await new QoderIdeDelegations(async (session) => session === 'parent'
      ? detail('outer-request', 'delegate-inner') : detail('inner-request', 'inner-read', 'grandchild')).collect(await parent(), {});
    const root = batch.records.find(row => row['event.name'] === 'gen_ai.agent.invoke' && row['gen_ai.session.id'] === 'parent')!;
    const nested = batch.records.find(row => row['event.name'] === 'gen_ai.agent.invoke' && row['gen_ai.session.id'] === 'child')!;
    expect(nested['gen_ai.agent.parent.invocation.id']).toBe(root['gen_ai.agent.invocation.id']);
    expect(nested['gen_ai.agent.invocation.id']).not.toBe(root['gen_ai.agent.invocation.id']);
    const inner = batch.records.filter(row => row['gen_ai.session.id'] === 'grandchild');
    expect(inner.length).toBeGreaterThan(0);
    expect(inner.every(row => row['gen_ai.agent.parent.id'] === 'child'
      && row['gen_ai.agent.parent.invocation.id'] === nested['gen_ai.agent.invocation.id'])).toBe(true);
  });

  it('does not fabricate a completed result for an asynchronous receipt', async () => {
    const batch = await new QoderIdeDelegations(async () => detail()).collect(await parent('background', { run_in_background: true }), {});
    expect(batch.records.map(row => row['event.name'])).toEqual(['gen_ai.agent.invoke']);
  });

  it('retains retryable state for incomplete/mismatched child source evidence', async () => {
    const batch = await new QoderIdeDelegations(async () => detail('request-1', 'missing-native-tool')).collect(await parent(), {});
    expect(batch.records.some(row => row['gen_ai.session.id'] === 'child')).toBe(false);
    expect(Object.values(batch.state)[0]!.done).not.toBe(true);
  });

  it('does not use an Agent error as a successful final model reply', async () => {
    const input = await parent(); input[1]!['tool.result.status'] = 'error';
    const batch = await new QoderIdeDelegations(async () => detail()).collect(input, {});
    const result = batch.records.find(row => row['event.name'] === 'gen_ai.agent.result')!;
    expect(result['tool.result.status']).toBe('error');
    const last = batch.records.filter(row => row['event.name'] === 'llm.response').at(-1)!;
    expect(last['gen_ai.output.messages']).toBeUndefined();
    expect(last['gen_ai.response.finish_reasons']).toBeUndefined();
  });

  it('waits for the final SQLite model row rather than committing an earlier tool-only snapshot', async () => {
    const metadata = detail(); metadata.messages.pop(); metadata.tokens.pop();
    const batch = await new QoderIdeDelegations(async () => metadata).collect(await parent(), {});
    expect(batch.records.some(row => row['gen_ai.session.id'] === 'child')).toBe(false);
    expect(Object.values(batch.state)[0]!.done).not.toBe(true);
  });

  it('collects a text-only child from native request metadata and its verified foreground reply', async () => {
    const metadata = detail(); metadata.messages = metadata.messages.filter(row => row.role !== 'tool').slice(0, 2); metadata.tokens = metadata.tokens.slice(0, 1);
    await fs.unlink(path.join(root, 'child.jsonl'));
    const batch = await new QoderIdeDelegations(async () => metadata).collect(await parent(), {});
    const responses = batch.records.filter(row => row['gen_ai.session.id'] === 'child' && row['event.name'] === 'llm.response');
    expect(responses).toHaveLength(1);
    expect(responses[0]!['gen_ai.output.messages']).toEqual([{ role: 'assistant', parts: [{ type: 'text', content: 'delivered-native-result' }] }]);
  });

  it('resumes tool discovery across a transcript larger than the per-cycle byte budget and a restart', async () => {
    let clock = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const prefix = Array.from({ length: 24 }, () => ({ type: 'progress', data: { detail: 'x'.repeat(200000) } }));
    await child([...prefix, nativeCall('read-1'), nativeResult('read-1')] as any);
    const first = await new QoderIdeDelegations(async () => detail()).collect(await parent(), {});
    expect(first.records.filter(row => row['gen_ai.session.id'] === 'child')).toEqual([]);
    expect(Object.values(first.state)[0]!.childScan!.offset).toBeGreaterThan(0);
    clock += 6000;
    const second = await new QoderIdeDelegations(async () => detail()).collect([], JSON.parse(JSON.stringify(first.state)));
    expect(second.records.filter(row => row['event.name'] === 'llm.response')).toHaveLength(2);
    expect(second.records.some(row => row['event.name'].startsWith('gen_ai.agent.'))).toBe(false);
  });

  it('rotates pending lookups beyond the per-cycle budget even as retries expire', async () => {
    let clock = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const input = (await Promise.all(Array.from({ length: 24 }, (_, i) => parent(`queued-${i}`)))).flat();
    const calls = new Set<string>();
    const reader = new QoderIdeDelegations(async (_session, call) => { calls.add(call); return null; });
    let batch = await reader.collect(input, {});
    for (let i = 0; i < 5; i++) { clock += 6000; batch = await reader.collect([], batch.state); }
    expect(calls.size).toBe(24);
  });

  it.each(['qoder-cli', 'qoder-app', 'qoder-cn', 'qoder-idea'])('preserves the separate %s protocol', async type => {
    const input = await parent(); for (const record of input) record['gen_ai.agent.type'] = type;
    const resolver = vi.fn(async () => detail());
    expect((await new QoderIdeDelegations(resolver).collect(input, {})).records).toEqual([]);
    expect(resolver).not.toHaveBeenCalled();
  });
});
