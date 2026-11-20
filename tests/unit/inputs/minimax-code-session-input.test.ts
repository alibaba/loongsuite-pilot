import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { StateStore } from '../../../src/checkpoints/state-store.js';
import { InputManager } from '../../../src/core/input-manager.js';
import { DirectoryPluginStrategy } from '../../../src/deployment/directory-plugin-strategy.js';
import { JsonlFlusher } from '../../../src/flushers/jsonl-flusher.js';
import { HttpFlusher } from '../../../src/flushers/http-flusher.js';
import { MultiFlusher } from '../../../src/flushers/multi-flusher.js';
import { OtlpTraceFlusher } from '../../../src/flushers/otlp-trace-flusher.js';
import { CodexTurnJournal } from '../../../src/flushers/codex-turn-journal.js';
import { MinimaxCodeSessionInput } from '../../../src/inputs/minimax-code-session/minimax-code-session-input.js';
import { loadDatabaseSync } from '../../../src/utils/node-sqlite.js';
import { MockFlusher } from '../../helpers/mock-flusher.js';

class TestInput extends MinimaxCodeSessionInput {
  async poll() {
    const entries = await this.collect();
    if (entries.length) this.onEntriesQueued();
    return entries;
  }
}

const fixture = new URL('../../fixtures/minimax-code/', import.meta.url);

async function setup(root: string, records = fixture, initiallyCompleted = true) {
  const profileDir = path.join(root, 'profile');
  const hookDir = path.join(root, 'hooks');
  const statePath = path.join(root, 'state.json');
  const manifest = JSON.parse(await fs.readFile(new URL('manifest.json', records), 'utf8'));
  const suffix = Buffer.from(manifest.sessionId).toString('base64url');
  const sourceDir = path.join(profileDir, 'v2', 'sessions', '2026', '11', '20', `22-47-46-172-session_${suffix}`);
  const source = path.join(sourceDir, 'messages.jsonl');
  const observations = path.join(hookDir, createHash('sha256').update(manifest.sessionId).digest('hex'));
  const sourceText = await fs.readFile(new URL('messages.jsonl', records), 'utf8');
  const lines = (await fs.readFile(new URL('hooks.jsonl', records), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const turns = JSON.parse(await fs.readFile(new URL('turns.json', records), 'utf8'));
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.mkdir(observations, { recursive: true });
  await fs.writeFile(path.join(sourceDir, 'manifest.json'), JSON.stringify(manifest));
  const dbDir = path.join(profileDir, 'v2', 'sqlite');
  await fs.mkdir(dbDir, { recursive: true });
  const Database = loadDatabaseSync()!;
  const dbFile = path.join(dbDir, 'runtime-state.sqlite');
  const db = new Database(dbFile);
  try {
    db.exec('CREATE TABLE local_runtime_turn_ingress (turn_id TEXT PRIMARY KEY, session_id TEXT, status TEXT, completed_at_ms INTEGER)');
    const insert = db.prepare('INSERT INTO local_runtime_turn_ingress VALUES (?, ?, ?, ?)');
    for (const turn of turns) {
      insert.run(turn.turnId, manifest.sessionId, initiallyCompleted ? turn.status : 'running',
        initiallyCompleted ? turn.completedAtMs : null);
    }
  } finally { db.close(); }

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
  const settleNativeTurns = () => {
    const writer = new Database(dbFile);
    try {
      const settle = writer.prepare('UPDATE local_runtime_turn_ingress SET status = ?, completed_at_ms = ? WHERE turn_id = ?');
      for (const turn of turns) settle.run(turn.status, turn.completedAtMs, turn.turnId);
    } finally { writer.close(); }
  };
  return { openInput, addObservations, settleNativeTurns, lines, observations, source, sourceText };
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

it('waits for the native completion receipt and includes both steps of one continued Stop turn', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minimax-session-continued-'));
  try {
    const f = await setup(root, new URL('continuation/', fixture), false);
    const partial = f.sourceText.trimEnd().split('\n').slice(0, 3).join('\n') + '\n';
    await fs.writeFile(f.source, partial);
    await f.addObservations(f.lines.slice(0, 3));
    const { input, stateStore } = await f.openInput();
    expect(await input.poll()).toEqual([]);
    expect(await input.poll()).toEqual([]);
    expect(await fs.readdir(f.observations)).toHaveLength(1);
    expect(stateStore.keys()).toEqual([]);

    await f.addObservations(f.lines.slice(3));
    expect(await input.poll()).toEqual([]);
    f.settleNativeTurns();
    expect(await input.poll()).toEqual([]);
    expect(await input.poll()).toEqual([]);
    expect(stateStore.keys()).toEqual([]);
    await fs.writeFile(f.source, f.sourceText);
    expect(await input.poll()).toEqual([]);
    const events = await input.poll();
    expect(events.map(event => event['event.name'])).toEqual(['llm.request', 'llm.response', 'llm.request', 'llm.response']);
    expect(events.map(event => event.time_unix_nano)).toEqual([
      '1795216940889000000', '1795216940985000000', '1795216941013000000', '1795216941062000000',
    ]);
    expect(events.filter(event => event['gen_ai.turn.start'] === true)).toEqual([events[0]]);
    expect(events.filter(event => event['gen_ai.turn.end'] === true)).toEqual([events[3]]);
    expect(events[2]['gen_ai.input.messages_delta']).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'fixture user step 2' }] },
    ]);
    expect(new Set(events.map(event => event['event.id'])).size).toBe(4);
    await stateStore.save();
    const restarted = await f.openInput();
    expect(await restarted.input.poll()).toEqual([]);
    expect(await fs.readdir(f.observations)).toEqual([]);
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

it.each([false, true])('retries a failed JSONL row without redelivering accepted rows (discovery restart: %s)', async restart => {
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
    await manager.startInput(input.id);
    await failedRow;

    stateStore.setOffset('unrelated-input', 1);
    await stateStore.save();
    const statePath = path.join(root, 'state.json');
    const outputFile = path.join(outputDir, 'minimax-code-all.jsonl');
    expect(JSON.parse(await fs.readFile(statePath, 'utf8'))).toEqual({ 'unrelated-input': { lastOffset: 1 } });
    expect(await fs.readdir(f.observations)).toHaveLength(4);
    expect((await fs.readFile(outputFile, 'utf8')).trim().split('\n')).toHaveLength(1);
    expect(healthy.batchCalls).toHaveLength(1);

    if (restart) {
      await manager.stopInput(input.id);
      expect(input.checkpointFailed).toBe(false);
      expect(await fs.readdir(f.observations)).toHaveLength(4);
      expect(stateStore.keys()).toEqual(['unrelated-input']);
    }
    const flushed = once(manager, 'flushed');
    recover = true;
    if (restart) await manager.startInput(input.id);
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
    const installed = path.join(root, 'plugins', 'loongsuite-pilot');
    const sourceDir = fileURLToPath(new URL('../../../assets/plugins/minimax-code/loongsuite-pilot/', import.meta.url));
    const dataDir = path.join(root, 'pilot-data');
    const strategy = new DirectoryPluginStrategy(dataDir);
    const def = {
      id: 'minimax-code', displayName: 'MiniMax Code', deployMode: 'directory-plugin' as const,
      detection: { paths: [], commands: [] }, directoryPlugin: { sourceDir, targetDir: installed },
    };
    expect((await strategy.deploy(def)).success).toBe(true);
    const cached = path.join(root, 'plugin-hook-cache', 'cached-plugin');
    await fs.cp(installed, cached, { recursive: true });
    const payload = {
      hook_event_name: 'PostToolUse', session_id: 'synthetic-session', turn_id: 'synthetic-turn',
      cwd: root, tool_use_id: 'tool-1', tool_input: 'PRIVATE_INPUT', tool_response: 'PRIVATE_RESPONSE',
      transcript_path: '/temporary/PRIVATE_TRANSCRIPT', prompt: 'PRIVATE_PROMPT',
    };
    const runHook = (plugin: string) => {
      const hook = spawnSync(process.execPath, [path.join(plugin, 'scripts', 'observe.mjs')], {
        input: JSON.stringify(payload), encoding: 'utf8',
      });
      expect(hook.status).toBe(0);
      expect(hook.stdout).toBe('{}\n');
    };
    runHook(cached);
    const sessionKey = createHash('sha256').update(payload.session_id).digest('hex');
    const spool = path.join(dataDir, 'state', 'minimax-code', 'hook-events', sessionKey);
    const [filename] = await fs.readdir(spool);
    const record = await fs.readFile(path.join(spool, filename), 'utf8');
    expect(record).not.toContain('PRIVATE_');
    expect(JSON.parse(record)).toEqual({
      observedAtMs: expect.any(Number),
      payload: { hook_event_name: 'PostToolUse', session_id: 'synthetic-session', turn_id: 'synthetic-turn', cwd: root, tool_use_id: 'tool-1' },
    });
    expect(await strategy.undeploy(def)).toBe(true);
    runHook(cached);
    expect(await fs.readdir(spool)).toEqual([filename]);
    expect((await strategy.deploy(def)).success).toBe(true);
    runHook(cached);
    expect(await fs.readdir(spool)).toEqual([filename]);
    runHook(installed);
    expect(await fs.readdir(spool)).toHaveLength(2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('retains source progress behind a real HTTP rejection and resumes the failed chunk', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minimax-http-acceptance-'));
  const manager = new InputManager();
  const accepted: string[][] = [];
  let rejected = 0;
  let recover = false;
  const server = createServer(async (request, response) => {
    const parts = [];
    for await (const chunk of request) parts.push(chunk);
    const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (accepted.length > 0 && !recover) {
      rejected++;
      response.writeHead(503).end();
    } else {
      accepted.push(body.entries.map((entry: Record<string, string>) => entry['event.id']));
      response.writeHead(200).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('loopback listener unavailable');
  const http = new HttpFlusher({ enabled: true, url: `http://127.0.0.1:${address.port}`,
    batchMaxSize: 4, flushIntervalMs: 60_000, requestTimeoutMs: 1_000 });
  try {
    const f = await setup(root);
    await fs.writeFile(f.source, f.sourceText);
    await f.addObservations(f.lines);
    const { input, stateStore } = await f.openInput();
    const outputDir = path.join(root, 'output');
    const jsonl = new JsonlFlusher({ enabled: true, outputDir, rotateDaily: false, maxFileSizeMb: 10 });
    await jsonl.start();
    await http.start();
    manager.setFlusher(new MultiFlusher([jsonl, http]));
    manager.registerInput(input);
    await manager.startInput(input.id);
    await vi.waitFor(() => expect(rejected).toBeGreaterThan(0), { timeout: 4_000 });
    stateStore.setOffset('other-source', 1);
    await stateStore.save();
    const statePath = path.join(root, 'state.json');
    expect(JSON.parse(await fs.readFile(statePath, 'utf8'))).toEqual({ 'other-source': { lastOffset: 1 } });
    expect(await fs.readdir(f.observations)).toHaveLength(4);
    expect(accepted).toHaveLength(1);

    recover = true;
    await vi.waitFor(async () => {
      const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
      expect(Object.keys(state).filter(key => key.startsWith('minimax-code-session:'))).toHaveLength(2);
    }, { timeout: 4_000 });
    const jsonlRows = (await fs.readFile(path.join(outputDir, 'minimax-code-all.jsonl'), 'utf8')).trim().split('\n');
    expect(accepted.map(chunk => chunk.length)).toEqual([4, 4]);
    expect(accepted.flat()).toEqual(jsonlRows.map(row => JSON.parse(row)['event.id']));
    expect(new Set(accepted.flat()).size).toBe(8);
  } finally {
    await manager.stopAll();
    await http.shutdown();
    const closed = once(server, 'close');
    server.close();
    await closed;
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('retains completed MiniMax turns in the durable OTLP journal through exporter failure and restart', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minimax-otlp-retention-'));
  const manager = new InputManager();
  const directory = path.join(root, 'journal');
  const journal = () => new CodexTurnJournal(directory, 100, ['minimax-code']);
  let successes = 0;
  const makeFlusher = (succeed: boolean) => new OtlpTraceFlusher({
    enabled: true, serviceName: 'minimax-fixture', captureMessageContent: false, protocol: 'http/protobuf',
    endpoints: [{ endpoint: 'http://127.0.0.1:1/v1/traces', headers: {} }], dataDir: root,
  }, undefined, () => ({
    export(spans, callback) {
      if (succeed) successes += spans.length;
      callback(succeed ? { code: 0 } : { code: 1, error: new Error('fixture exporter offline') });
    },
    async shutdown() {},
  }), journal());
  const first = makeFlusher(false);
  const restarted = makeFlusher(true);
  try {
    const f = await setup(root);
    await fs.writeFile(f.source, f.sourceText);
    await f.addObservations(f.lines);
    const { input, stateStore } = await f.openInput();
    await first.start();
    manager.setFlusher(first);
    manager.registerInput(input);
    await manager.startInput(input.id);
    await vi.waitFor(() => {
      expect(stateStore.keys().filter(key => stateStore.getPersistedState(key)?.extra?.completed)).toHaveLength(2);
    }, { timeout: 4_000 });
    const retained: string[] = [];
    for await (const group of journal().load()) retained.push(...group.map(entry => entry['event.id']));
    expect(retained).toHaveLength(8);
    await manager.stopAll();
    await first.shutdown();

    await restarted.start();
    await restarted.flush();
    expect(successes).toBeGreaterThan(0);
    for await (const _ of journal().load()) throw new Error('acknowledged journal group retained');
  } finally {
    await manager.stopAll();
    await first.shutdown();
    await restarted.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});
