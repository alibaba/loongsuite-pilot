import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QoderTraceInput } from '../../../src/inputs/qoder-trace/qoder-trace-input.js';
import { QoderCnTraceInput } from '../../../src/inputs/qoder-cn-trace/qoder-cn-trace-input.js';
import { StateStore } from '../../../src/checkpoints/state-store.js';
import { getTodayDateString } from '../../../src/utils/fs-utils.js';

let root: string;
afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

describe.each(['qoder', 'qoder-cn'] as const)('%s old Hook backlog', agentId => {
  it('drains a legal line larger than one read batch, its successor and a restarted partial tail once', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-legacy-history-'));
    const logDir = path.join(root, 'history');
    fs.mkdirSync(logDir);
    const filename = `${agentId}-${getTodayDateString()}.jsonl`;
    const file = path.join(logDir, filename);
    const event = (id: string, text: string) => ({ 'event.id': id, 'event.name': 'llm.response',
      time_unix_nano: String(BigInt(Date.now()) * 1_000_000n), 'gen_ai.agent.type': agentId,
      'gen_ai.session.id': 'synthetic-session', 'gen_ai.turn.id': `turn-${id}`,
      'gen_ai.usage.input_tokens': 11, 'gen_ai.usage.output_tokens': 7,
      'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content: text }] }] });
    fs.writeFileSync(file, JSON.stringify(event('large', 'x'.repeat(16 * 1024 ** 2))) + '\n'
      + JSON.stringify(event('small', 'trailing answer')) + '\n');
    const store = new StateStore(path.join(root, 'state.json'));
    const create = () => agentId === 'qoder'
      ? new QoderTraceInput({ dataDir: root, logDir, stateStore: store })
      : new QoderCnTraceInput({ dataDir: root, logDir, stateStore: store });
    let input = create();
    store.set(input.id, { lastFile: filename, lastOffset: 0 });
    const read = () => (input as unknown as { readHookJsonl(): Promise<Record<string, unknown>[]> }).readHookJsonl();
    const records: Record<string, unknown>[] = [];
    for (let i = 0; i < 8 && (store.get(input.id).lastOffset ?? 0) < fs.statSync(file).size; i++) records.push(...await read());
    expect(records.map(row => row['event.id'])).toEqual(['large', 'small']);
    expect(records.map(row => row['gen_ai.usage.input_tokens'])).toEqual([11, 11]);
    expect(store.get(input.id).lastOffset).toBe(fs.statSync(file).size);
    expect(await read()).toEqual([]);
    const saved = store.get(input.id).lastOffset;
    const tail = JSON.stringify(event('partial', '中文🙂'));
    const bytes = Buffer.from(tail);
    const split = bytes.indexOf(Buffer.from('中文')) + 1;
    fs.appendFileSync(file, bytes.subarray(0, split));
    expect(await read()).toEqual([]);
    expect(store.get(input.id).lastOffset).toBe(saved);
    await input.stop();
    input = create();
    fs.appendFileSync(file, Buffer.concat([bytes.subarray(split), Buffer.from('\n')]));
    const completed = await read();
    expect(completed.map(row => row['event.id'])).toEqual(['partial']);
    expect(JSON.stringify(completed)).toContain('中文🙂');
    expect(await read()).toEqual([]);
    await input.stop();
  });
});
