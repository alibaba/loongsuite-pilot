import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, it, vi } from 'vitest';
import { StateStore } from '../../../src/checkpoints/state-store.js';
import { InputManager } from '../../../src/core/input-manager.js';
import { JsonlFlusher } from '../../../src/flushers/jsonl-flusher.js';
import { MultiFlusher } from '../../../src/flushers/multi-flusher.js';
import { MinimaxCodeSessionInput } from '../../../src/inputs/minimax-code-session/minimax-code-session-input.js';
import { MockFlusher } from '../../helpers/mock-flusher.js';

class TestInput extends MinimaxCodeSessionInput {
  async poll() {
    const entries = await this.collect();
    if (entries.length) this.onEntriesQueued();
    return entries;
  }
}

const fixture = new URL('../../fixtures/minimax-code/', import.meta.url);

async function setup(root: string) {
  const profileDir = path.join(root, 'profile');
  const hookDir = path.join(root, 'hooks');
  const statePath = path.join(root, 'state.json');
  const manifest = JSON.parse(await fs.readFile(new URL('manifest.json', fixture), 'utf8'));
  const suffix = Buffer.from(manifest.sessionId).toString('base64url');
  const sourceDir = path.join(profileDir, 'v2', 'sessions', '2026', '11', '20', `22-47-46-172-session_${suffix}`);
  const source = path.join(sourceDir, 'messages.jsonl');
  const observations = path.join(hookDir, createHash('sha256').update(manifest.sessionId).digest('hex'));
  const sourceText = await fs.readFile(new URL('messages.jsonl', fixture), 'utf8');
  const lines = (await fs.readFile(new URL('hooks.jsonl', fixture), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.mkdir(observations, { recursive: true });
  await fs.writeFile(path.join(sourceDir, 'manifest.json'), JSON.stringify(manifest));

  const openInput = async () => {
    const stateStore = new StateStore(statePath);
    await stateStore.load();
    return { stateStore, input: new TestInput({ stateStore, profileDir, hookDir }) };
  };
  const addObservations = async (items: typeof lines) => {
    for (const item of items) {
      if (!['PreToolUse', 'PostToolUse', 'Stop'].includes(item.payload.hook_event_name)) continue;
      await fs.writeFile(path.join(observations, `${item.timeReceivedMs}-${randomUUID()}.json`), JSON.stringify({
        payload: item.payload, observedAtMs: item.timeReceivedMs,
      }));
    }
  };
  return { openInput, addObservations, lines, observations, source, sourceText };
}

it('uses durable native bytes, correlates tool timing and checkpoints completed turns across restart', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minimax-session-input-'));
  try {
    const f = await setup(root);
    const nativeLines = f.sourceText.trimEnd().split('\n');
    await fs.writeFile(f.source, nativeLines.slice(0, 3).join('\n') + '\n');
    await f.addObservations(f.lines.slice(0, 3));
    const initial = await f.openInput();
    expect(await initial.input.poll()).toEqual([]);
    const first = await initial.input.poll();
    expect(first.map(entry => entry['event.name'])).toEqual(['llm.request', 'llm.response']);
    expect(first[1]).toMatchObject({ 'gen_ai.usage.input_tokens': 9, 'gen_ai.turn.end': true });
    await initial.stateStore.save();

    // The real fixture resumes the existing session and adds a tool turn.
    // Pilot was stopped between these two writes.
    await fs.appendFile(f.source, nativeLines.slice(3).join('\n') + '\n');
    await f.addObservations(f.lines.slice(3));
    const restarted = await f.openInput();
    expect(await restarted.input.poll()).toEqual([]);
    const continued = await restarted.input.poll();
    expect(continued.map(entry => entry['event.name'])).toEqual([
      'llm.request', 'llm.response', 'tool.call', 'tool.result', 'llm.request', 'llm.response',
    ]);
    expect(continued[2]).toMatchObject({ 'gen_ai.tool.call.id': 'fixture-read-tool-v1', time_unix_nano: '1795215075346000000' });
    expect(continued[3]).toMatchObject({
      'gen_ai.tool.call.id': 'fixture-read-tool-v1', 'gen_ai.tool.call.duration': 54, time_unix_nano: '1795215075400000000',
    });
    expect(continued[4].time_unix_nano).toBe('1795215075421000000');
    expect(new Set(continued.map(entry => entry['event.id'])).size).toBe(continued.length);
    expect(continued.every(entry => entry['workspace.path'] === f.lines[3].payload.cwd)).toBe(true);
    await restarted.stateStore.save();

    await f.addObservations(f.lines);
    const rerun = await f.openInput();
    expect(await rerun.input.poll()).toEqual([]);
    expect(await fs.readdir(f.observations)).toEqual([]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('retains observations and waits for an unfinished record or temporarily unavailable source', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minimax-session-partial-'));
  try {
    const f = await setup(root);
    await f.addObservations(f.lines);
    const { input } = await f.openInput();
    expect(await input.poll()).toEqual([]);
    const incomplete = '{damaged historical line}\n' + f.sourceText.trimEnd();
    await fs.writeFile(f.source, incomplete);
    expect(await input.poll()).toEqual([]);
    expect(await input.poll()).toEqual([]);
    expect(await fs.readdir(f.observations)).toHaveLength(4);
    await fs.appendFile(f.source, '\n');
    expect(await input.poll()).toEqual([]);
    expect(await input.poll()).toHaveLength(8);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('holds native completion behind output acceptance while other inputs can save', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minimax-session-checkpoint-'));
  const manager = new InputManager();
  let accept!: () => void;
  const output = new Promise<void>(resolve => { accept = resolve; });
  try {
    const f = await setup(root);
    await fs.writeFile(f.source, f.sourceText);
    await f.addObservations(f.lines);
    const { input, stateStore } = await f.openInput();
    const flusher = new MockFlusher('minimax-delivery');
    let started!: () => void;
    const beganDelivery = new Promise<void>(resolve => { started = resolve; });
    flusher.sendBatch = async () => { started(); await output; };
    manager.setFlusher(flusher);
    manager.registerInput(input);
    await input.start();
    await beganDelivery;

    stateStore.setOffset('unrelated-input', 1);
    await stateStore.save();
    const statePath = path.join(root, 'state.json');
    expect(JSON.parse(await fs.readFile(statePath, 'utf8'))).toEqual({ 'unrelated-input': { lastOffset: 1 } });
    expect(await fs.readdir(f.observations)).toHaveLength(4);

    const flushed = once(manager, 'flushed');
    accept();
    await flushed;
    await vi.waitFor(async () => {
      const saved = JSON.parse(await fs.readFile(statePath, 'utf8'));
      expect(Object.keys(saved).filter(key => key.startsWith('minimax-code-session:'))).toHaveLength(2);
    });
  } finally {
    accept();
    await manager.stopAll();
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('retries a failed JSONL row through fan-out without advancing the source or redelivering accepted rows', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minimax-session-fanout-'));
  const manager = new InputManager();
  try {
    const f = await setup(root);
    await fs.writeFile(f.source, f.sourceText);
    await f.addObservations(f.lines);
    const { input, stateStore } = await f.openInput();
    const outputDir = path.join(root, 'output');
    const jsonl = new JsonlFlusher({ enabled: true, outputDir, rotateDaily: false, maxFileSizeMb: 10 });
    await jsonl.start();
    const healthy = new MockFlusher('healthy');
    const send = jsonl.send.bind(jsonl);
    const attempted: string[] = [];
    let recover = false;
    let failure!: () => void;
    const failedRow = new Promise<void>(resolve => { failure = resolve; });
    vi.spyOn(jsonl, 'send').mockImplementation(async entry => {
      const id = entry['event.id'];
      attempted.push(id);
      if (!recover && attempted.length > 1) {
        failure();
        throw new Error('injected JSONL write failure between rows');
      }
      await send(entry);
    });
    manager.setFlusher(new MultiFlusher([healthy, jsonl]));
    manager.registerInput(input);
    await input.start();
    await failedRow;

    stateStore.setOffset('unrelated-input', 1);
    await stateStore.save();
    const statePath = path.join(root, 'state.json');
    const outputFile = path.join(outputDir, 'minimax-code-all.jsonl');
    expect(JSON.parse(await fs.readFile(statePath, 'utf8'))).toEqual({ 'unrelated-input': { lastOffset: 1 } });
    expect(await fs.readdir(f.observations)).toHaveLength(4);
    expect((await fs.readFile(outputFile, 'utf8')).trim().split('\n')).toHaveLength(1);
    expect(healthy.batchCalls).toHaveLength(1);

    const flushed = once(manager, 'flushed');
    recover = true;
    await flushed;
    await vi.waitFor(async () => {
      const saved = JSON.parse(await fs.readFile(statePath, 'utf8'));
      expect(Object.keys(saved).filter(key => key.startsWith('minimax-code-session:'))).toHaveLength(2);
    });
    const ids = (await fs.readFile(outputFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line)['event.id']);
    expect(ids).toHaveLength(8);
    expect(new Set(ids).size).toBe(8);
    expect(attempted[2]).toBe(attempted[1]);
    expect(healthy.batchCalls).toHaveLength(1);
  } finally {
    await manager.stopAll();
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('writes only observed identity metadata when the real plugin receives private Hook content', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minimax-hook-metadata-'));
  try {
    const installed = path.join(root, 'installed');
    const source = new URL('../../../assets/plugins/minimax-code/loongsuite-pilot/', import.meta.url);
    await fs.cp(source, installed, { recursive: true });
    const dataDir = path.join(root, 'pilot-data');
    await fs.writeFile(path.join(installed, '.loongsuite-pilot-managed.json'), JSON.stringify({
      schemaVersion: 1, owner: 'loongsuite-pilot', agentId: 'minimax-code', dataDir,
    }));
    const payload = {
      hook_event_name: 'PostToolUse', session_id: 'synthetic-session', turn_id: 'synthetic-turn',
      cwd: root, tool_use_id: 'tool-1', tool_input: 'PRIVATE_INPUT', tool_response: 'PRIVATE_RESPONSE',
      transcript_path: '/temporary/PRIVATE_TRANSCRIPT', prompt: 'PRIVATE_PROMPT',
    };
    const hook = spawnSync(process.execPath, [path.join(installed, 'scripts', 'observe.mjs')], {
      input: JSON.stringify(payload), encoding: 'utf8',
    });
    expect(hook.status).toBe(0);
    expect(hook.stdout).toBe('{}\n');
    const sessionKey = createHash('sha256').update(payload.session_id).digest('hex');
    const spool = path.join(dataDir, 'state', 'minimax-code', 'hook-events', sessionKey);
    const [filename] = await fs.readdir(spool);
    const record = await fs.readFile(path.join(spool, filename), 'utf8');
    expect(record).not.toContain('PRIVATE_');
    expect(JSON.parse(record)).toEqual({
      observedAtMs: expect.any(Number),
      payload: { hook_event_name: 'PostToolUse', session_id: 'synthetic-session', turn_id: 'synthetic-turn', cwd: root, tool_use_id: 'tool-1' },
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
