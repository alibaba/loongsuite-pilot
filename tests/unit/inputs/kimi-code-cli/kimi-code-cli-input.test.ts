import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { InputManager } from '../../../../src/core/input-manager.js';
import { JsonlFlusher } from '../../../../src/flushers/jsonl-flusher.js';
import { MultiFlusher } from '../../../../src/flushers/multi-flusher.js';
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

it('does not let an idle pre-existing copy claim a live native session in another workspace', async () => {
  vi.spyOn(Date, 'now').mockReturnValue((turnOneAt + turnTwoAt) / 2);
  const { stateFile, sessionDir, sessionId, first, second } = await createSession();
  await fs.rm(path.join(sessionDir, 'wd_work_fixture'), { recursive: true });
  const buckets = new Map<string, string>();
  for (const label of ['review-a', 'review-b']) {
    const cwd = path.join(path.dirname(sessionDir), label);
    const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 12);
    const key = `wd_${label}_${hash}`;
    buckets.set(key, cwd);
    await fs.mkdir(path.join(sessionDir, key));
  }
  const discoveryOrder = [];
  for await (const item of await fs.opendir(sessionDir)) discoveryOrder.push(item.name);
  expect(discoveryOrder).toHaveLength(2);
  const actual = discoveryOrder[1]!;
  let genuineWire!: string;
  for (const key of discoveryOrder) {
    const session = path.join(sessionDir, key, sessionId);
    const target = path.join(session, 'agents', 'main', 'wire.jsonl');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(path.join(session, 'state.json'), JSON.stringify({ id: sessionId, cwd: buckets.get(actual), version: 2 }));
    await fs.writeFile(target, first.join('\n') + '\n');
    if (key === actual) genuineWire = target;
  }
  const { input, entries } = await createInput(stateFile, sessionDir, false);
  try {
    expect(entries).toHaveLength(0);
    await fs.appendFile(genuineWire, second.join('\n') + '\n');
    for (let i = 0; i < 4; i++) await poll(input);
    expect(entries).toHaveLength(2);
  } finally { await input.stop(); }
});

it('keeps a distinct new prompt sharing the last turn timestamp after an atomic shifted rewrite', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(turnOneAt - 1);
  const { stateFile, sessionDir, wire, first, second } = await createSession();
  await fs.writeFile(wire, first.join('\n') + '\n');
  const { input, entries } = await createInput(stateFile, sessionDir, false);
  try {
    expect(entries).toHaveLength(6);
    const replacement = `${wire}.partial`;
    const terminalTime = JSON.parse(first.at(-1)!).time;
    const accepted = [...first];
    accepted.splice(1, 0, JSON.stringify({ type: 'context.append_message', agentId: 'main', time: turnOneAt }));
    const equalTime = second.map(line => {
      const row = JSON.parse(line);
      return JSON.stringify({ ...row, time: row.time - turnTwoAt + terminalTime });
    });
    await fs.writeFile(replacement, [...accepted, ...equalTime].join('\n') + '\n');
    await fs.rename(replacement, wire);
    clock.mockReturnValue(turnTwoAt + 50);
    await poll(input);
    expect(entries).toHaveLength(8);
  } finally { await input.stop(); }
});

it.each(['retry', 'stop and re-enable'])('waits for real JSONL acceptance across %s without duplicating a successful mirror', async recovery => {
  vi.spyOn(Date, 'now').mockReturnValue(turnOneAt - 1);
  const { stateFile, sessionDir, sessionId, wire, first } = await createSession();
  const outputDir = path.join(path.dirname(stateFile), 'blocked-output');
  const mirrorDir = path.join(path.dirname(stateFile), 'mirror-output');
  await fs.writeFile(outputDir, 'a file cannot be used as the output directory');
  const store = new StateStore(stateFile);
  await store.load();
  const input = new KimiCodeCliInput({ stateStore: store, sessionDir, captureMessageContent: false, pollIntervalMs: 60_000 });
  const manager = new InputManager();
  const output = new JsonlFlusher({ outputDir, rotateDaily: false, maxFileSizeMb: 100 });
  const mirror = new JsonlFlusher({ outputDir: mirrorDir, rotateDaily: false, maxFileSizeMb: 100 });
  const flusher = new MultiFlusher([output, mirror]);
  manager.setFlusher(flusher);
  manager.registerInput(input);

  let signalBlocked!: () => void;
  const blocked = new Promise<void>(resolve => { signalBlocked = resolve; });
  const send = output.send.bind(output);
  vi.spyOn(output, 'send').mockImplementation(async entry => {
    try {
      await send(entry);
    } catch (error) {
      signalBlocked();
      throw error;
    }
  });
  let signalMirror!: () => void;
  let written = 0;
  const mirrored = new Promise<void>(resolve => { signalMirror = resolve; });
  const sendMirror = mirror.send.bind(mirror);
  vi.spyOn(mirror, 'send').mockImplementation(async entry => {
    await sendMirror(entry);
    if (++written === 6) signalMirror();
  });

  await manager.startInput(input.id);
  await poll(input);
  const key = `${input.id}:${sessionId}`;
  try {
    await fs.writeFile(wire, first.join('\n') + '\n');
    const cycle = poll(input);
    await Promise.all([blocked, mirrored]);
    store.set('other-input', { lastOffset: 9 });
    await store.save();
    const fresh = new StateStore(stateFile);
    await fresh.load();
    expect(fresh.get(key).lastOffset ?? 0).toBe(0);
    expect(fresh.get('other-input').lastOffset).toBe(9);

    if (recovery === 'stop and re-enable') {
      await manager.stopInput(input.id);
      expect(input.checkpointFailed).toBe(false);
      expect(store.getPersistedState(key)?.lastOffset ?? 0).toBe(0);
    }
    await fs.unlink(outputDir);
    if (recovery === 'stop and re-enable') await manager.startInput(input.id);
    await cycle;
    await poll(input);

    const readRecords = async (dir: string) => (await fs.readFile(path.join(dir, 'kimi-code-cli-all.jsonl'), 'utf8'))
      .trimEnd().split('\n').map(line => JSON.parse(line) as AgentActivityEntry);
    const [accepted, mirroredRecords] = await Promise.all([readRecords(outputDir), readRecords(mirrorDir)]);
    expect(accepted).toHaveLength(6);
    expect(mirroredRecords.map(entry => entry['event.id'])).toEqual(accepted.map(entry => entry['event.id']));
    expect(store.getPersistedState(key)?.lastOffset).toBe((await fs.stat(wire)).size);
  } finally {
    await manager.stopAll();
    await flusher.shutdown();
  }
}, 15_000);

it('retries a partially written JSONL batch without repeating the accepted prefix', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-kimi-partial-output-'));
  roots.push(root);
  const flusher = new JsonlFlusher({ outputDir: root, rotateDaily: false, maxFileSizeMb: 100 });
  const events = ['a', 'b', 'c'].map(id => ({
    'event.id': id, 'event.name': 'other', 'gen_ai.agent.type': 'kimi-code-cli', 'gen_ai.session.id': 's',
    'user.id': 'u', time_unix_nano: '1795192262007000000',
  }) satisfies AgentActivityEntry);
  const send = flusher.send.bind(flusher);
  let blocked = true;
  vi.spyOn(flusher, 'send').mockImplementation(async entry => {
    if (entry['event.id'] === 'b' && blocked) {
      blocked = false;
      throw new Error('simulated append failure');
    }
    await send(entry);
  });
  const deliver = flusher.createBatchDelivery(events, undefined, undefined, { requireAcceptance: true });
  await expect(deliver()).rejects.toThrow('simulated append failure');
  await deliver();
  const rows = (await fs.readFile(path.join(root, 'kimi-code-cli-all.jsonl'), 'utf8')).trimEnd().split('\n');
  expect(rows.map(row => JSON.parse(row)['event.id'])).toEqual(['a', 'b', 'c']);
});

it('remembers all accepted prompt identities sharing a rewrite boundary', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(turnOneAt - 1);
  const { stateFile, sessionDir, wire, first, second } = await createSession();
  const time = JSON.parse(first.at(-1)!).time;
  const adjacent = (ordinal: number) => second.map(line => {
    const record = JSON.parse(line);
    record.time = time;
    if (record.turnId !== undefined) record.turnId = ordinal;
    if (record.promptId !== undefined) record.promptId = `native-prompt-${ordinal}`;
    if (record.event?.turnId !== undefined) record.event.turnId = String(ordinal);
    if (record.event?.startedAt !== undefined) record.event.startedAt = time;
    return JSON.stringify(record);
  });
  const { input, entries } = await createInput(stateFile, sessionDir, false);
  try {
    await fs.writeFile(wire, first.join('\n') + '\n');
    await poll(input);
    expect(entries).toHaveLength(6);
    const secondTurn = adjacent(1);
    const thirdTurn = adjacent(2);
    await fs.appendFile(wire, secondTurn.join('\n') + '\n');
    await poll(input);
    await fs.appendFile(wire, thirdTurn.join('\n') + '\n');
    await poll(input);
    expect(entries).toHaveLength(10);

    const replacement = wire + '.next';
    const shifted = [first[0], JSON.stringify({ type: 'context.append_message', agentId: 'main', time }), ...first.slice(1)];
    await fs.writeFile(replacement, [...shifted, ...secondTurn, ...thirdTurn, ...adjacent(3)].join('\n') + '\n');
    await fs.rename(replacement, wire);
    await poll(input);
    expect(entries).toHaveLength(12);
    expect(new Set(entries.map(entry => entry['event.id'])).size).toBe(12);
  } finally {
    await input.stop();
  }
});
