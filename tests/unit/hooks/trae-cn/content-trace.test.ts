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
  const input = new Reader({ stateStore: state, sessionDir: dir, auxLogDir: dir });
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
      'gen_ai.span.kind': kind, 'event.name': event, 'gen_ai.tool.call.id': kind === 'TOOL' ? 'call_1' : undefined }) + '\n';
    await writeFile(file, row('ENTRY', 'other'));
    expect(await input.poll()).toEqual([]);
    const record = (message: string, extra: object) => cbor.encode({ time: [2026,323,8,4,4,1,0,0,0],
      fields: Object.fromEntries(Object.entries({ message, trace_id: trace, ...extra }).map(([k,v]) => [k,Buffer.from(v)])) });
    await appendFile(stream, deflateRawSync(Buffer.concat([
      record('context resolve applied to task request', { session_id: session, turn_id: '2'.repeat(24) }),
      record('tool execution started', { toolcall_id: 'call_1', tool_name: 'Read' }),
    ])));
    await appendFile(file, row('TOOL', 'tool.call'));
    expect((await input.poll()).map(e => e.trace_id)).toEqual([trace, trace]);
    await appendFile(file, row('LLM', 'llm.response'));
    expect((await input.poll()).map(e => e.trace_id)).toEqual([trace]);
    expect(await input.poll()).toEqual([]);
  } finally { await input.close(); await rm(dir, { recursive: true, force: true }); }
});
