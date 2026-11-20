import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { StateStore } from '../../../../src/checkpoints/state-store.js';
import { KimiCodeCliInput } from '../../../../src/inputs/kimi-code-cli/kimi-code-cli-input.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';

const roots: string[] = [];
const fixturePath = new URL('../../../fixtures/kimi-code-cli/2.7.2-loopback-wire.jsonl', import.meta.url);
const turnOneAt = 1795192262007;
const turnTwoAt = 1795192262847;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function createSession() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-kimi-code-'));
  roots.push(root);
  const sessionDir = path.join(root, 'sessions');
  const sessionId = 'session_loopback-fixture';
  const session = path.join(sessionDir, 'wd_work_fixture', sessionId);
  const wire = path.join(session, 'agents', 'main', 'wire.jsonl');
  const stateFile = path.join(root, 'input-state.json');
  await fs.mkdir(path.dirname(wire), { recursive: true });
  await fs.writeFile(path.join(session, 'state.json'), JSON.stringify({ id: sessionId, cwd: root, version: 2 }));
  const fixture = (await fs.readFile(fixturePath, 'utf8')).trimEnd().split('\n');
  const secondTurn = fixture.findIndex(line => {
    const record = JSON.parse(line);
    return record.type === 'turn.prompt' && record.turnId === 1;
  });
  return { sessionDir, wire, stateFile, sessionId, first: fixture.slice(0, secondTurn), second: fixture.slice(secondTurn) };
}

async function createInput(stateFile: string, sessionDir: string, captureMessageContent = true) {
  const store = new StateStore(stateFile);
  await store.load();
  const input = new KimiCodeCliInput({ stateStore: store, sessionDir, captureMessageContent, pollIntervalMs: 60_000 });
  const entries: AgentActivityEntry[] = [];
  input.on('entries', batch => entries.push(...batch));
  await input.start();
  await poll(input);
  return { input, store, entries };
}

function poll(input: KimiCodeCliInput): Promise<void> {
  return (input as unknown as { runCycle(): Promise<void> }).runCycle();
}

it('waits for the terminal line and resumes after restart without replaying the first turn', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(turnOneAt - 1);
  const { stateFile, sessionDir, wire, sessionId, first, second } = await createSession();
  const { input, entries, store } = await createInput(stateFile, sessionDir);
  try {
    const terminal = first.at(-1)!;
    await fs.writeFile(wire, first.slice(0, -1).join('\n') + '\n' + terminal.slice(0, -2));
    await poll(input);
    expect(entries).toEqual([]);
    const saved = store.get(`${input.id}:${wire}`).lastOffset!;
    expect(saved).toBeGreaterThan(0);
    expect(saved).toBeLessThan((await fs.stat(wire)).size);

    await fs.appendFile(wire, terminal.slice(-2) + '\n');
    await poll(input);
    expect(entries.map(entry => entry['event.name'])).toEqual([
      'llm.request', 'llm.response', 'tool.call', 'tool.result', 'llm.request', 'llm.response',
    ]);
    expect(new Set(entries.map(entry => entry['gen_ai.session.id']))).toEqual(new Set([sessionId]));
    expect(new Set(entries.map(entry => entry.trace_id)).size).toBe(1);
    const [request, response, call, result, secondRequest, secondResponse] = entries;
    expect(request?.['gen_ai.response.id']).toBe(response?.['gen_ai.response.id']);
    expect(response?.['gen_ai.output.messages']).toMatchObject([{
      role: 'assistant', parts: [{ type: 'tool_call', id: 'call-local-read', name: 'Read' }],
    }]);
    expect(call?.['gen_ai.tool.call.id']).toBe(result?.['gen_ai.tool.call.id']);
    expect(result?.['gen_ai.tool.call.result']).toContain('synthetic tool result');
    expect(secondRequest?.time_unix_nano).toBe(result?.time_unix_nano);
    expect(secondResponse?.['gen_ai.usage.output_tokens']).toBe(5);
    expect(store.get(`${input.id}:${wire}`).lastOffset).toBe((await fs.stat(wire)).size);
  } finally {
    await input.stop();
  }

  const resumed = await createInput(stateFile, sessionDir);
  try {
    expect(resumed.entries).toEqual([]);
    await fs.appendFile(wire, second.join('\n') + '\n');
    await poll(resumed.input);
    expect(resumed.entries.map(entry => entry['event.name'])).toEqual(['llm.request', 'llm.response']);
    expect(resumed.entries[0]?.['gen_ai.turn.id']).not.toBe(entries[0]?.['gen_ai.turn.id']);
    expect(JSON.stringify(resumed.entries)).toContain('Synthetic resumed message');
    expect(JSON.stringify(resumed.entries)).not.toContain('Synthetic first message');
    await poll(resumed.input);
    expect(resumed.entries).toHaveLength(2);
  } finally {
    await resumed.input.stop();
  }
});

it('baselines earlier turns and retains relationships and usage with capture turned off', async () => {
  vi.spyOn(Date, 'now').mockReturnValue((turnOneAt + turnTwoAt) / 2);
  const { stateFile, sessionDir, wire, first, second } = await createSession();
  await fs.writeFile(wire, first.join('\n') + '\n');
  const { input, entries } = await createInput(stateFile, sessionDir, false);
  try {
    expect(entries).toEqual([]);
    await fs.appendFile(wire, second.join('\n') + '\n');
    await poll(input);
    expect(entries).toHaveLength(2);
    expect(entries[1]?.['gen_ai.usage.input_tokens']).toBe(9);
    expect(entries[0]?.['gen_ai.response.id']).toBe(entries[1]?.['gen_ai.response.id']);
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toMatch(/Synthetic|local dummy response/);
    expect(await fs.readFile(stateFile, 'utf8')).not.toMatch(/Synthetic|local dummy response/);
  } finally {
    await input.stop();
  }
});

it('keeps tool identity and timing when capture is disabled before the first turn', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(turnOneAt - 1);
  const { stateFile, sessionDir, wire, first } = await createSession();
  await fs.writeFile(wire, first.join('\n') + '\n');
  const { input, entries } = await createInput(stateFile, sessionDir, false);
  try {
    expect(entries).toHaveLength(6);
    expect(entries.filter(entry => entry['gen_ai.tool.call.id'] === 'call-local-read')).toHaveLength(2);
    expect(entries.find(entry => entry['event.name'] === 'tool.result')?.['gen_ai.tool.call.duration']).toBeGreaterThan(0);
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toMatch(/Synthetic|local dummy response|synthetic tool result|loopback-read\.txt/);
  } finally {
    await input.stop();
  }
});

it('preserves the committed cursor while the source directory is temporarily unavailable', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(turnOneAt - 1);
  const { stateFile, sessionDir, wire, first, second } = await createSession();
  await fs.writeFile(wire, first.join('\n') + '\n');
  const { input, store, entries } = await createInput(stateFile, sessionDir);
  try {
    const key = `${input.id}:${wire}`;
    const committed = store.get(key).lastOffset;
    const unavailable = sessionDir + '-offline';
    await fs.rename(sessionDir, unavailable);
    await fs.appendFile(path.join(unavailable, path.relative(sessionDir, wire)), second.join('\n') + '\n');
    await poll(input);
    expect(entries).toHaveLength(6);
    expect(store.get(key).lastOffset).toBe(committed);
    await fs.rename(unavailable, sessionDir);
    await poll(input);
    expect(entries).toHaveLength(8);
    expect(store.get(key).lastOffset).toBe((await fs.stat(wire)).size);
  } finally {
    await input.stop();
  }
});
