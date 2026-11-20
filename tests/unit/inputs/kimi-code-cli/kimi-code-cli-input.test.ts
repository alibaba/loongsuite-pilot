import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspacePolicy } from '../../../../src/core/workspace-policy.js';
import type { InputRuntimeDelta } from '../../../../src/inputs/base/input-runtime-metrics.js';
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
    const saved = store.get(`${input.id}:${sessionId}`).lastOffset!;
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
    expect(store.get(`${input.id}:${sessionId}`).lastOffset).toBe((await fs.stat(wire)).size);
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
  const { stateFile, sessionDir, sessionId, wire, first, second } = await createSession();
  await fs.writeFile(wire, first.join('\n') + '\n');
  const { input, store, entries } = await createInput(stateFile, sessionDir);
  try {
    const key = `${input.id}:${sessionId}`;
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

it('uses the native fork boundary and collects only turns the fork owns', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(turnOneAt - 1);
  const { stateFile, sessionDir, wire, sessionId, first, second } = await createSession();
  const session = path.join(path.dirname(wire), '..', '..');
  const state = { id: sessionId, version: 2, cwd: sessionDir, forkedFrom: 'session_original',
    createdAt: (turnOneAt + turnTwoAt) / 2 };
  await fs.writeFile(path.join(session, 'state.json'), JSON.stringify(state));
  const { input, entries } = await createInput(stateFile, sessionDir);
  try {
    await fs.writeFile(wire, first.join('\n') + '\n');
    await poll(input);
    expect(entries).toEqual([]);
    await fs.appendFile(wire, second.join('\n') + '\n');
    await poll(input);
    expect(entries).toHaveLength(2);
    expect(JSON.stringify(entries)).toContain('Synthetic resumed message');
    expect(JSON.stringify(entries)).not.toContain('Synthetic first message');
  } finally {
    await input.stop();
  }
});

it.skipIf(process.platform === 'win32')('does not expose a wire journal outside the Kimi session directory', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(turnOneAt - 1);
  const { stateFile, sessionDir, wire, first } = await createSession();
  const outside = path.join(path.dirname(sessionDir), 'outside-private-wire.jsonl');
  await fs.writeFile(outside, first.join('\n') + '\n');
  await fs.symlink(outside, wire);
  const { input, entries } = await createInput(stateFile, sessionDir);
  try { expect(entries).toHaveLength(0); }
  finally { await input.stop(); }
});

it('does not emit the same native session and event IDs twice after a workspace copy', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(turnOneAt - 1);
  const { stateFile, sessionDir, sessionId, wire, first } = await createSession();
  await fs.writeFile(wire, first.join('\n') + '\n');
  const { input, entries } = await createInput(stateFile, sessionDir);
  try {
    expect(entries).toHaveLength(6);
    const copied = path.join(sessionDir, 'wd_work_copy', sessionId);
    await fs.mkdir(path.dirname(copied), { recursive: true });
    await fs.cp(path.join(path.dirname(wire), '..', '..'), copied, { recursive: true });
    await poll(input);
    expect(entries).toHaveLength(6);
    expect(new Set(entries.map(entry => entry['event.id'])).size).toBe(entries.length);
  } finally { await input.stop(); }
});

it('does not persist a source cursor before the collected batch reaches the output queue', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(turnOneAt - 1);
  const { stateFile, sessionDir, sessionId, wire, first } = await createSession();
  const { input, entries, store } = await createInput(stateFile, sessionDir);
  const exposed = input as unknown as {
    collectWire(...args: unknown[]): Promise<AgentActivityEntry[] | undefined>;
  };
  const collectWire = exposed.collectWire.bind(exposed);
  let waitForScan!: () => void;
  let releaseScan!: () => void;
  const collectedFirst = new Promise<void>(resolve => { waitForScan = resolve; });
  const afterCollect = new Promise<void>(resolve => { releaseScan = resolve; });
  vi.spyOn(exposed, 'collectWire').mockImplementation(async (...args: unknown[]) => {
    const result = await collectWire(...args);
    waitForScan();
    await afterCollect;
    return result;
  });
  await fs.writeFile(wire, first.join('\n') + '\n');
  const pendingCycle = poll(input);
  try {
    await collectedFirst;
    expect(entries).toHaveLength(0);
    await store.save();
    const restart = new StateStore(stateFile);
    await restart.load();
    expect(restart.get(`${input.id}:${sessionId}`).lastOffset ?? 0).toBe(0);
  } finally {
    releaseScan();
    await pendingCycle;
    await input.stop();
  }
});

it.each(['unchanged', 'shifted'])('retains a new turn after an atomic rewrite with %s accepted bytes', async prefix => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(turnOneAt - 1);
  const { stateFile, sessionDir, wire, first, second } = await createSession();
  await fs.writeFile(wire, first.join('\n') + '\n');
  const { input, entries } = await createInput(stateFile, sessionDir, false);
  try {
    expect(entries).toHaveLength(6);
    const replacement = `${wire}.partial`;
    const accepted = [...first];
    if (prefix === 'shifted') {
      accepted.splice(1, 0, JSON.stringify({ type: 'context.append_message', agentId: 'main', time: turnOneAt }));
    }
    await fs.writeFile(replacement, accepted.join('\n') + '\n');
    await fs.rename(replacement, wire);
    await fs.appendFile(wire, second.join('\n') + '\n');
    clock.mockReturnValue(turnTwoAt + 50);
    await poll(input);
    expect(entries).toHaveLength(8);
    expect(new Set(entries.map(entry => entry['event.id'])).size).toBe(8);
  } finally { await input.stop(); }
});

it('waits for scoped output acknowledgement before a concurrent save can persist the cursor', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(turnOneAt - 1);
  const { stateFile, sessionDir, sessionId, wire, first } = await createSession();
  const { input, store } = await createInput(stateFile, sessionDir);
  let acknowledge!: () => void;
  const ack = new Promise<void>(resolve => { acknowledge = resolve; });
  let hasEnqueued!: () => void;
  const enqueued = new Promise<void>(resolve => { hasEnqueued = resolve; });
  input.once('entries', () => {
    input.holdCheckpointUntil(ack);
    hasEnqueued();
  });
  await fs.writeFile(wire, first.join('\n') + '\n');
  const cycle = poll(input);
  const key = `${input.id}:${sessionId}`;
  try {
    await enqueued;
    store.set('unrelated', { lastOffset: 7 });
    await store.save();
    expect(store.get(key).lastOffset).toBe((await fs.stat(wire)).size);
    const restart = new StateStore(stateFile);
    await restart.load();
    expect(restart.get(key).lastOffset).toBeUndefined();
    expect(restart.get('unrelated').lastOffset).toBe(7);
    acknowledge();
    await cycle;
    expect(store.getPersistedState(key)?.lastOffset).toBe((await fs.stat(wire)).size);
  } finally {
    acknowledge();
    await cycle;
    await input.stop();
  }
});

it('commits through turns excluded by the workspace policy', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(turnOneAt - 1);
  const { stateFile, sessionDir, sessionId, wire, first } = await createSession();
  const { input, store, entries } = await createInput(stateFile, sessionDir);
  input.setWorkspacePolicy(new WorkspacePolicy([path.dirname(sessionDir)]));
  try {
    await fs.writeFile(wire, first.join('\n') + '\n');
    await poll(input);
    expect(entries).toEqual([]);
    expect(store.getPersistedState(`${input.id}:${sessionId}`)?.lastOffset).toBe((await fs.stat(wire)).size);
  } finally {
    await input.stop();
  }
});

it.skipIf(process.platform === 'win32')('rejects a FIFO and a nested directory symlink', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(turnOneAt - 1);
  const { stateFile, sessionDir, wire, first } = await createSession();
  execFileSync('mkfifo', [wire]);
  const outside = path.join(path.dirname(sessionDir), 'outside-agent');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'wire.jsonl'), first.join('\n') + '\n');
  const { input, entries } = await createInput(stateFile, sessionDir);
  try {
    expect(entries).toEqual([]);
    await fs.unlink(wire);
    await fs.rmdir(path.dirname(wire));
    await fs.symlink(outside, path.dirname(wire), 'dir');
    await poll(input);
    expect(entries).toEqual([]);
  } finally {
    await input.stop();
  }
});

it.skipIf(process.platform === 'win32')('confines metadata reads and accepts a deliberately linked Kimi home', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(turnOneAt - 1);
  const { stateFile, sessionDir, wire, first } = await createSession();
  const originalHome = path.dirname(sessionDir);
  const launcherHome = path.join(originalHome, 'linked-home');
  await fs.symlink(originalHome, launcherHome, 'dir');
  const state = path.join(path.dirname(wire), '..', '..', 'state.json');
  const outside = path.join(originalHome, 'outside-meta.json');
  await fs.rename(state, outside);
  await fs.symlink(outside, state);
  await fs.writeFile(wire, first.join('\n') + '\n');
  const { input, entries } = await createInput(stateFile, path.join(launcherHome, 'sessions'));
  try {
    expect(entries).toEqual([]);
    await fs.unlink(state);
    await fs.rename(outside, state);
    await poll(input);
    expect(entries).toHaveLength(6);
  } finally {
    await input.stop();
  }
});

it('finishes 65 cross-page turns over bounded polls without evicting their progress', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(turnOneAt - 1);
  const { stateFile, sessionDir, wire, first } = await createSession();
  const count = 65;
  const filler = JSON.stringify({ type: 'context.append_message', agentId: 'main', time: turnOneAt,
    message: { content: 'synthetic local context\n'.repeat(112_000) } });
  await fs.writeFile(wire, [...first.slice(0, -1), filler, filler, first.at(-1)!].join('\n') + '\n');
  for (let index = 0; index < count - 1; index++) {
    const id = `session_catchup_${index}`;
    const session = path.join(sessionDir, 'wd_work_fixture', id);
    const copy = path.join(session, 'agents', 'main', 'wire.jsonl');
    await fs.mkdir(path.dirname(copy), { recursive: true });
    await fs.writeFile(path.join(session, 'state.json'), JSON.stringify({ id, cwd: sessionDir, version: 2 }));
    await fs.copyFile(wire, copy, constants.COPYFILE_FICLONE);
  }
  const { input, entries } = await createInput(stateFile, sessionDir, false);
  const seen = new Set<string>();
  const metrics: InputRuntimeDelta[] = [];
  input.on('input-runtime-delta', delta => metrics.push(delta));
  try {
    for (let attempt = 0; attempt < count * 2 + 5 && seen.size < count; attempt++) {
      await poll(input);
      for (const entry of entries) seen.add(entry['gen_ai.session.id']);
    }
    expect(seen.size).toBe(count);
    expect(entries).toHaveLength(count * 6);
    expect(Math.max(...metrics.map(delta => delta.rawReadBytes))).toBeLessThanOrEqual(32 * 1024 * 1024);
  } finally {
    await input.stop();
  }
}, 20_000);
