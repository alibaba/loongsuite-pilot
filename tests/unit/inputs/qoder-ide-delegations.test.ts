import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { QoderIdeDelegations, QODER_NATIVE_SOURCE, type IdeDelegation } from '../../../src/inputs/qoder-trace/ide-delegations.js';

let root: string;
const epoch = Date.now() - 60000;
const at = (ms: number) => new Date(epoch + ms).toISOString();
const secret = 'synthetic-private-prompt';
const nativeCall = (call: string, name = 'Read', input: object = { file_path: 'fixture.txt' }) => ({
  type: 'assistant', sessionId: 'child', timestamp: at(200),
  message: { role: 'assistant', content: [{ type: 'tool_use', id: call, name, input }] },
});
const nativeResult = (call: string) => ({ type: 'user', sessionId: 'child', timestamp: at(250),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: call, content: 'synthetic-file-result' }] } });
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
    { ...nativeResult(call), sessionId: 'parent' },
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
afterEach(async () => { await fs.rm(path.dirname(root), { recursive: true, force: true }); });

describe('Qoder IDE native request delegation', () => {
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
    expect(responses[1]!['gen_ai.output.messages']).toBeUndefined();
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

  it.each(['qoder-cli', 'qoder-app', 'qoder-cn', 'qoder-idea'])('preserves the separate %s protocol', async type => {
    const input = await parent(); for (const record of input) record['gen_ai.agent.type'] = type;
    const resolver = vi.fn(async () => detail());
    expect((await new QoderIdeDelegations(resolver).collect(input, {})).records).toEqual([]);
    expect(resolver).not.toHaveBeenCalled();
  });
});
