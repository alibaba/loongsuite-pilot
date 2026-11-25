import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { InputManager } from '../../src/core/input-manager.js';
import { JsonlFlusher } from '../../src/flushers/jsonl-flusher.js';
import { newState, transformDshRecord } from '../../src/inputs/dsh/dsh-event-transform.js';
import { ClientType, type AgentActivityEntry } from '../../src/types/index.js';

const fixtureValue = 'AKIAIOSFODNN7EXAMPLE';
const fixtures: string[] = [];

async function projectAsJsonl(
  depth: number,
  captureMessageContent: boolean,
  output: 'structured' | 'text' | 'mixed' = 'structured',
  wrapped = true,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-tool-privacy-review-'));
  fixtures.push(root);
  let content: unknown = fixtureValue;
  for (let n = 0; n < depth; n++) content = { nested: content };
  const richPart = { type: 'fixture-structured', data: content };
  const result = {
    isError: true,
    content: output === 'text'
      ? [{ type: 'text', text: fixtureValue }, { type: 'text', text: 'suffix' }]
      : output === 'mixed'
        ? [{ type: 'image', data: 'synthetic-image' }, { type: 'text', text: `ordinary header\n${fixtureValue}` }]
        : [richPart],
  };
  const rawRecords = [
    { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-synthetic', name: 'read' } },
    { type: 'tool/result', data: { turn: 1, step: 1, message: {
      role: wrapped ? 'user' : 'tool', source: { callId: 'call-synthetic' },
      ...(wrapped ? { content: [{ type: 'tool-result', toolCallId: 'call-synthetic', ...result }] } : result),
    } } },
    { type: 'assistant/chunk', data: { turn: 1, step: 2, chunk: { type: 'text-delta', text: 'done' } } },
  ];
  const state = newState();
  const entries = rawRecords.map((raw, index) => {
    const row = JSON.parse(JSON.stringify({ ...raw, sid: 'fixture', time: 1_800_000_000_000 + index }));
    return transformDshRecord(row, ClientType.Dsh, state);
  }).filter((value): value is AgentActivityEntry => value !== null);
  const manager = new InputManager();
  manager.setUserId('fixture-user');
  manager.setAgentsConfig({ dsh: { captureMessageContent } });
  manager.setMaskConfig({ mode: 'all', types: [], replacementMode: 'placeholder' });
  const flusher = new JsonlFlusher({ enabled: true, outputDir: root, rotateDaily: false });
  await flusher.start();
  try {
    manager.setFlusher(flusher);
    await manager.flushPreparedEntries(entries);
  } finally {
    await flusher.shutdown();
  }
  const paths = await fs.readdir(root);
  return (await Promise.all(paths.map(file => fs.readFile(path.join(root, file), 'utf8'))))
    .join('').trim().split('\n').map(row => JSON.parse(row));
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

it.each([true, false].flatMap(wrapped => [3, 33].map(depth => ({ wrapped, depth }))))(
  'masks structured output at depth $depth in real JSONL (wrapped=$wrapped)', async ({ wrapped, depth }) => {
    const rows = await projectAsJsonl(depth, true, 'structured', wrapped);
    const tool = rows.find(row => row['event.name'] === 'tool.result');
    const request = rows.find(row => row['event.name'] === 'llm.request');
    const fields = [tool?.['gen_ai.tool.call.result'], request?.['gen_ai.input.messages'], request?.['gen_ai.input.messages_delta']];
    expect(fields.map(field => Boolean(field))).toEqual([true, true, true]);
    expect(fields.map(field => JSON.stringify(field).includes(fixtureValue))).toEqual([false, false, false]);
    expect(fields.map(field => JSON.stringify(field).includes('[ACCESSKEY_MASKED]'))).toEqual([true, true, true]);
    expect(tool?.['gen_ai.tool.call.id']).toBe('call-synthetic');
    expect(fields).toEqual(Array(3).fill([{ role: 'tool', parts: [{
      type: 'tool_call_response', id: 'call-synthetic', response: { output: expect.any(String), isError: true },
    }] }]));
  },
);

it('removes both structured tool result and historical input when content collection is off', async () => {
  const rows = await projectAsJsonl(33, false);
  const tool = rows.find(row => row['event.name'] === 'tool.result');
  const request = rows.find(row => row['event.name'] === 'llm.request');
  expect(tool?.['gen_ai.tool.call.id']).toBe('call-synthetic');
  expect(tool?.['gen_ai.tool.call.result']).toBeUndefined();
  expect(request?.['gen_ai.input.messages']).toBeUndefined();
  expect(request?.['gen_ai.input.messages_delta']).toBeUndefined();
});

it.each([true, false])('retains masking across two native text parts (wrapped=%s)', async wrapped => {
  const rows = await projectAsJsonl(0, true, 'text', wrapped);
  const tool = rows.find(row => row['event.name'] === 'tool.result');
  const request = rows.find(row => row['event.name'] === 'llm.request');
  const fields = [tool?.['gen_ai.tool.call.result'], request?.['gen_ai.input.messages'], request?.['gen_ai.input.messages_delta']];
  expect(fields.map(field => Boolean(field))).toEqual([true, true, true]);
  expect(fields.map(field => JSON.stringify(field).includes(fixtureValue))).toEqual([false, false, false]);
  expect(fields.map(field => JSON.stringify(field).includes('[ACCESSKEY_MASKED]'))).toEqual([true, true, true]);
});

it.each([true, false])('masks multiline text next to rich native parts (wrapped=%s)', async wrapped => {
  const rows = await projectAsJsonl(0, true, 'mixed', wrapped);
  const tool = rows.find(row => row['event.name'] === 'tool.result');
  const request = rows.find(row => row['event.name'] === 'llm.request');
  const fields = [tool?.['gen_ai.tool.call.result'], request?.['gen_ai.input.messages'], request?.['gen_ai.input.messages_delta']];
  for (const field of fields) {
    const encoded = JSON.stringify(field);
    expect(encoded).toContain('ordinary header');
    expect(encoded).toContain('synthetic-image');
    expect(encoded).toContain('[ACCESSKEY_MASKED]');
    expect(encoded).not.toContain(fixtureValue);
  }
});
