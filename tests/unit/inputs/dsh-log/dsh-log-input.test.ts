import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { StateStore } from '../../../../src/checkpoints/state-store.js';
import { DshLogInput } from '../../../../src/inputs/dsh-log/dsh-log-input.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';

class TestDshLogInput extends DshLogInput {
  runCollect(): Promise<AgentActivityEntry[]> {
    return this.collect();
  }
}

function prefix(
  sid: string,
  provider: string,
  prompt: string,
  system = `${provider}-system`,
): Record<string, unknown>[] {
  return [
    { type: 'turn/start', sid, time: 1, data: { turn: 1 } },
    { type: 'step/start', sid, time: 2, data: { turn: 1, step: 1 } },
    { type: 'user/message', sid, time: 3, data: { content: [{ type: 'text', text: prompt }] } },
    {
      type: 'request/header', sid, time: 4,
      data: { header: { config: { provider, model: `${provider}-model` }, system } },
    },
    { type: 'request/context', sid, time: 5, data: { provider, model: `${provider}-model` } },
  ];
}

function chunk(sid: string, time = 10, turn = 1, step = 1): Record<string, unknown> {
  return {
    type: 'assistant/chunk', sid, time,
    data: { turn, step, chunk: { type: 'block-start' } },
  };
}

async function appendRecords(filePath: string, records: Record<string, unknown>[]): Promise<void> {
  await fs.appendFile(filePath, records.map(record => JSON.stringify(record)).join('\n') + '\n');
}

describe('DshLogInput state isolation and restart recovery', () => {
  let tmpDir: string;
  let statePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-log-input-'));
    statePath = path.join(tmpDir, 'input-state.json');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function makeInput(store = new StateStore(statePath)): Promise<{
    store: StateStore;
    input: TestDshLogInput;
  }> {
    await store.load();
    return {
      store,
      input: new TestDshLogInput({ stateStore: store, sessionDir: tmpDir }),
    };
  }

  it('keeps aggregators isolated when two session files advance across poll cycles', async () => {
    const fileA = path.join(tmpDir, 'dsh-session-a.jsonl');
    const fileB = path.join(tmpDir, 'dsh-session-b.jsonl');
    await appendRecords(fileA, prefix('session-a', 'provider-a', 'prompt-a'));
    await appendRecords(fileB, prefix('session-b', 'provider-b', 'prompt-b'));

    const { input } = await makeInput();
    await input.runCollect();
    await appendRecords(fileA, [chunk('session-a')]);
    await appendRecords(fileB, [chunk('session-b')]);
    const entries = await input.runCollect();
    const requests = entries.filter(entry => entry['event.name'] === 'llm.request');

    expect(requests).toHaveLength(2);
    const requestA = requests.find(entry => entry['gen_ai.session.id'] === 'session-a')!;
    const requestB = requests.find(entry => entry['gen_ai.session.id'] === 'session-b')!;
    expect(requestA['gen_ai.provider.name']).toBe('provider-a');
    expect(requestB['gen_ai.provider.name']).toBe('provider-b');
    expect(JSON.stringify(requestA['gen_ai.input.messages'])).toContain('prompt-a');
    expect(JSON.stringify(requestA['gen_ai.input.messages'])).not.toContain('prompt-b');
    expect(JSON.stringify(requestB['gen_ai.input.messages'])).toContain('prompt-b');
    expect(JSON.stringify(requestB['gen_ai.input.messages'])).not.toContain('prompt-a');
  });

  it('rehydrates an active turn after restart without persisting prompt content', async () => {
    const file = path.join(tmpDir, 'dsh-session-a.jsonl');
    await appendRecords(file, prefix('session-a', 'provider-a', 'private-prompt'));

    const first = await makeInput();
    await first.input.runCollect();
    await first.store.save();
    expect(await fs.readFile(statePath, 'utf-8')).not.toContain('private-prompt');

    await appendRecords(file, [chunk('session-a')]);
    const second = await makeInput();
    const entries = await second.input.runCollect();
    const request = entries.find(entry => entry['event.name'] === 'llm.request');

    expect(request?.['gen_ai.provider.name']).toBe('provider-a');
    expect(JSON.stringify(request?.['gen_ai.input.messages'])).toContain('private-prompt');
  });

  it('restores the last header after a completed turn and pairs a headerless next turn', async () => {
    const file = path.join(tmpDir, 'dsh-session-a.jsonl');
    await appendRecords(file, [
      ...prefix('session-a', 'provider-a', 'first-prompt', 'private-system'),
      chunk('session-a'),
      {
        type: 'assistant/message', sid: 'session-a', time: 11,
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'response-1',
            content: [{ type: 'text', text: 'first answer' }],
            source: { provider: 'provider-a', model: 'provider-a-model' },
          },
        },
      },
      { type: 'turn/end', sid: 'session-a', time: 12, data: { turn: 1 } },
    ]);

    const first = await makeInput();
    await first.input.runCollect();
    await first.store.save();
    const persisted = await fs.readFile(statePath, 'utf-8');
    expect(persisted).toContain('dshLastHeaderOffset');
    expect(persisted).not.toContain('private-system');
    expect(persisted).not.toContain('first-prompt');

    await appendRecords(file, [
      { type: 'turn/start', sid: 'session-a', time: 20, data: { turn: 2 } },
      { type: 'step/start', sid: 'session-a', time: 21, data: { turn: 2, step: 1 } },
      {
        type: 'user/message', sid: 'session-a', time: 22,
        data: { turn: 2, content: [{ type: 'text', text: 'continue-session' }] },
      },
      { type: 'request/context', sid: 'session-a', time: 23, data: { turn: 2, step: 1 } },
      chunk('session-a', 24, 2),
      {
        type: 'assistant/message', sid: 'session-a', time: 25,
        data: {
          turn: 2,
          step: 1,
          message: {
            id: 'response-2',
            content: [{ type: 'text', text: 'second answer' }],
            source: { provider: 'provider-a', model: 'provider-a-model' },
          },
        },
      },
      { type: 'turn/end', sid: 'session-a', time: 26, data: { turn: 2 } },
    ]);

    const second = await makeInput();
    const entries = await second.input.runCollect();
    expect(entries.map(entry => entry['event.name'])).toEqual([
      'other',
      'llm.request',
      'llm.response',
    ]);
    const request = entries[1];
    expect(request['gen_ai.provider.name']).toBe('provider-a');
    expect(request['gen_ai.request.model']).toBe('provider-a-model');
    expect(request['gen_ai.system_instructions']).toEqual([
      { type: 'text', content: 'private-system' },
    ]);
    expect(JSON.stringify(request['gen_ai.input.messages'])).toContain('continue-session');
  });

  it('migrates a legacy checkpoint by locating the last header once', async () => {
    const file = path.join(tmpDir, 'dsh-session-a.jsonl');
    await appendRecords(file, [
      ...prefix('session-a', 'provider-a', 'first-prompt'),
      chunk('session-a'),
      { type: 'turn/end', sid: 'session-a', time: 12, data: { turn: 1 } },
    ]);
    const first = await makeInput();
    await first.input.runCollect();
    await first.store.save();

    const rawState = JSON.parse(await fs.readFile(statePath, 'utf-8')) as Record<
      string,
      { extra?: Record<string, unknown> }
    >;
    const stateKey = Object.keys(rawState)[0];
    delete rawState[stateKey].extra?.dshLastHeaderOffset;
    await fs.writeFile(statePath, JSON.stringify(rawState));
    await appendRecords(file, [
      { type: 'turn/start', sid: 'session-a', time: 20, data: { turn: 2 } },
      { type: 'step/start', sid: 'session-a', time: 21, data: { turn: 2, step: 1 } },
      chunk('session-a', 22, 2),
    ]);

    const second = await makeInput();
    const entries = await second.input.runCollect();
    expect(entries.find(entry => entry['event.name'] === 'llm.request')?.['gen_ai.request.model'])
      .toBe('provider-a-model');
    await second.store.save();
    expect(await fs.readFile(statePath, 'utf-8')).toContain('dshLastHeaderOffset');
  });

  it('does not duplicate an already emitted request after restart replay', async () => {
    const file = path.join(tmpDir, 'dsh-session-a.jsonl');
    await appendRecords(file, [...prefix('session-a', 'provider-a', 'prompt-a'), chunk('session-a')]);

    const first = await makeInput();
    const initial = await first.input.runCollect();
    expect(initial.filter(entry => entry['event.name'] === 'llm.request')).toHaveLength(1);
    await first.store.save();

    await appendRecords(file, [chunk('session-a', 11)]);
    const second = await makeInput();
    const resumed = await second.input.runCollect();
    expect(resumed.filter(entry => entry['event.name'] === 'llm.request')).toHaveLength(0);
  });

  it('rehydrates the first-output boundary for TTFT after restart', async () => {
    const file = path.join(tmpDir, 'dsh-session-a.jsonl');
    await appendRecords(file, [
      ...prefix('session-a', 'provider-a', 'prompt-a'),
      {
        type: 'assistant/chunk', sid: 'session-a', time: 15,
        data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: 'thinking' } },
      },
    ]);

    const first = await makeInput();
    expect((await first.input.runCollect()).filter(e => e['event.name'] === 'llm.request')).toHaveLength(1);
    await first.store.save();

    await appendRecords(file, [{
      type: 'assistant/message', sid: 'session-a', time: 20,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'response-a',
          content: [{ type: 'reasoning', text: 'thinking' }],
          source: { provider: 'provider-a', model: 'provider-a-model' },
        },
      },
    }]);
    const second = await makeInput();
    const resumed = await second.input.runCollect();
    expect(resumed.filter(entry => entry['event.name'] === 'llm.request')).toHaveLength(0);
    const response = resumed.find(entry => entry['event.name'] === 'llm.response');
    expect(response?.['gen_ai.response.time_to_first_token']).toBe(10_000_000);
  });

  it('restores tool call names across restart', async () => {
    const file = path.join(tmpDir, 'dsh-session-a.jsonl');
    await appendRecords(file, [
      ...prefix('session-a', 'provider-a', 'prompt-a'),
      chunk('session-a'),
      {
        type: 'assistant/message', sid: 'session-a', time: 12,
        data: {
          turn: 1,
          step: 1,
          message: { content: [{ type: 'tool-call', id: 'call-a', name: 'read', arguments: '{}' }] },
        },
      },
      {
        type: 'tool/call', sid: 'session-a', time: 13,
        data: { turn: 1, step: 1, callId: 'call-a', name: 'read', arguments: '{}' },
      },
    ]);

    const first = await makeInput();
    await first.input.runCollect();
    await first.store.save();
    await appendRecords(file, [{
      type: 'tool/result', sid: 'session-a', time: 14,
      data: {
        turn: 1,
        step: 1,
        message: { source: { callId: 'call-a' }, content: [{ type: 'text', text: 'done' }] },
      },
    }]);

    const second = await makeInput();
    const entries = await second.input.runCollect();
    const result = entries.find(entry => entry['event.name'] === 'tool.result');
    expect(result?.['gen_ai.tool.call.id']).toBe('call-a');
    expect(result?.['gen_ai.tool.name']).toBe('read');
  });

  it('does not advance past a partial final JSONL record', async () => {
    const file = path.join(tmpDir, 'dsh-session-a.jsonl');
    const complete = prefix('session-a', 'provider-a', 'prompt-a');
    await appendRecords(file, complete);
    const partial = JSON.stringify(chunk('session-a'));
    await fs.appendFile(file, partial.slice(0, Math.floor(partial.length / 2)));

    const first = await makeInput();
    expect((await first.input.runCollect()).filter(e => e['event.name'] === 'llm.request')).toHaveLength(0);
    await first.store.save();
    await fs.appendFile(file, partial.slice(Math.floor(partial.length / 2)) + '\n');

    const second = await makeInput();
    expect((await second.input.runCollect()).filter(e => e['event.name'] === 'llm.request')).toHaveLength(1);
  });
});
