import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import cbor from 'cbor';
import { deflateRawSync } from 'node:zlib';
import { StateStore } from '../../../../src/checkpoints/state-store.js';
import { TraeCnLogInput } from '../../../../src/inputs/trae-cn-log/trae-cn-log-input.js';

class Reader extends TraeCnLogInput {
  poll() { return this.collect(); }
  close() { return this.onStop(); }
}

it('waits for the exact session and call ID before exporting any hook span', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'trae-content-'));
  const state = new StateStore(path.join(dir, 'state'));
  const input = new Reader({ stateStore: state, sessionDir: dir, auxLogDir: dir, hubRoot: dir });
  try {
    const native = path.join(dir, '20261119T135423/Modular');
    await mkdir(native, { recursive: true });
    const stream = path.join(native, 'ai_agent-0-2026-11-19.alaudalog');
    const header = Buffer.alloc(178);
    header.write('AalG'); header.write('Atab', 8); header.writeUInt32LE(152, 16);
    header.write('AALG', 152); header.writeUInt32LE(65536, 156); header.writeUInt32LE(6, 168);
    await writeFile(stream, header);
    const hook = 'b'.repeat(32), trace = 'a'.repeat(32), session = '1'.repeat(24);
    const file = path.join(dir, 'trae-cn-today.jsonl');
    const row = (kind: string, event: string) => JSON.stringify({ trace_id: hook, 'gen_ai.session.id': session,
      span_id: kind === 'AGENT' ? '3'.repeat(16) : '4'.repeat(16), parent_span_id: '5'.repeat(16),
      'gen_ai.span.kind': kind, 'event.name': event, 'gen_ai.tool.call.id': kind === 'TOOL' ? 'call_1' : undefined }) + '\n';
    await writeFile(file, row('ENTRY', 'other') + row('AGENT', 'other') + row('STEP', 'other'));
    expect(await input.poll()).toEqual([]);
    const record = (message: string, extra: object) => cbor.encode({ time: [2026,323,8,4,4,1,0,0,0],
      fields: Object.fromEntries(Object.entries({ message, trace_id: trace, ...extra }).map(([k,v]) => [k,typeof v === 'number' ? v : Buffer.from(v)])) });
    const reply = 'f'.repeat(24);
    const hubDir = path.join(dir, session);
    await mkdir(hubDir);
    const hubRow = (type: string, seq: number, fields: object) => JSON.stringify({type, seq,
      data: JSON.stringify({reply_to_message_id: reply, ...fields})}) + '\n';
    await writeFile(path.join(hubDir, reply + '.jsonl'), hubRow('metadata', 0, {trace_id: trace,
      turn_id: '2'.repeat(24), session_id: session}) + [25,57,65].map(seq => hubRow('token_usage', seq,
      {prompt_tokens: 10, completion_tokens: 9, total_tokens: 19, cache_read_input_tokens: 4})).join(''));
    await appendFile(stream, deflateRawSync(Buffer.concat([
      record('context resolve applied to task request', { session_id: session, turn_id: '2'.repeat(24) }),
      record('create_task', { chat_session_id: session, model_name: 'Doubao-Seed-2.1-Turbo' }),
      ...Array.from({length: 13}, (_, i) => record('recording history entry', {
        history_source: 'Server', source: 'llm_default', history_id: i.toString(16).padStart(24, '0'),
      })),
      ...[25,57,65,76,98,98].map(event_seq => record('[Hub] task event contract', { task_id: reply,
        conversation_id: session, event_type: 'token_usage', event_seq })),
      record('tool execution started', { toolcall_id: 'call_1', tool_name: 'Read' }),
      record('chat: runner completed', {turn_id: '2'.repeat(24)}),
    ])));
    await appendFile(file, row('TOOL', 'tool.call'));
    const batch = await input.poll();
    expect(batch.every(e => e.trace_id === trace)).toBe(true);
    const steps = batch.filter(e => e['gen_ai.span.kind'] === 'STEP');
    const responses = batch.filter(e => e['gen_ai.span.kind'] === 'LLM');
    expect(steps).toHaveLength(13);
    expect(responses).toHaveLength(13);
    for (const response of responses) {
      expect(response['gen_ai.request.model']).toBe('Doubao-Seed-2.1-Turbo');
      expect(steps.find(e => e.span_id === response.parent_span_id)?.['gen_ai.step.id']).toBe(response['gen_ai.response.id']);
    }
    expect(batch.find(e => e['gen_ai.span.kind'] === 'TOOL')?.parent_span_id).toBe('3'.repeat(16));
    const receipts = batch.filter(e => e['agent.trae-cn.source'] === 'hub_usage');
    expect(receipts.map(e => e['agent.trae-cn.event_seq'])).toEqual([25,57,65,76,98]);
    expect(receipts.map(e => e['gen_ai.usage.total_tokens'])).toEqual([19,19,19,undefined,undefined]);
    await appendFile(file, row('LLM', 'llm.response'));
    expect((await input.poll()).map(e => e['gen_ai.span.kind'])).toEqual(['AGENT']);
    expect(await input.poll()).toEqual([]);
  } finally { await input.close(); await rm(dir, { recursive: true, force: true }); }
});
