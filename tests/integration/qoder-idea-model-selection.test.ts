import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { QoderTraceInput } from '../../src/inputs/qoder-trace/qoder-trace-input.js';
import { StateStore } from '../../src/checkpoints/state-store.js';
import { InputManager } from '../../src/core/input-manager.js';
import { loadDatabaseSync } from '../../src/utils/node-sqlite.js';
import { publishQoderWakeup } from '../../assets/hooks/qoder/hook-wakeup.mjs';
import { MockFlusher } from '../helpers/mock-flusher.js';

const fixture = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = () => fixture.home || actual.homedir();
  return { ...actual, homedir, default: { ...actual, homedir } };
});

afterEach(async () => {
  if (fixture.home) await fs.rm(fixture.home, { recursive: true, force: true });
  fixture.home = '';
});

it('uses the JetBrains request model without token rows and ignores ambiguous clock matches', async () => {
  fixture.home = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-idea-model-'));
  const dbDir = path.join(fixture.home, '.qoder/shared_client/cache/db');
  await fs.mkdir(dbDir, { recursive: true });
  const Database = loadDatabaseSync();
  if (!Database) throw new Error('node:sqlite required');
  const db = new Database(path.join(dbDir, 'local.db'));
  const sessionId = 'fixture-session';
  const epoch = Date.now() - 60_000;
  const at = (ms: number) => new Date(epoch + ms).toISOString();
  try {
    db.exec(`CREATE TABLE chat_record (session_id TEXT, request_id TEXT, extra TEXT);
      CREATE TABLE chat_message (id TEXT, role TEXT, gmt_create INTEGER, token_info TEXT, model_info TEXT, session_id TEXT, request_id TEXT)`);
    const record = db.prepare('INSERT INTO chat_record VALUES (?, ?, ?)');
    const message = db.prepare('INSERT INTO chat_message VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const [id, ms, model] of [['one', 102, 'qmodel_latest'], ['two', 10100, 'auto'], ['other', 10102, 'fast']] as const) {
      record.run(sessionId, id, JSON.stringify({ modelConfig: { key: model } }));
      message.run(`db-${id}`, 'assistant', epoch + ms, null, null, sessionId, id);
    }
  } finally {
    db.close();
  }

  const transcript = path.join(fixture.home, 'native.jsonl');
  const rows = [0, 10000].flatMap((base, i) => [
    { type: 'user', sessionId, uuid: `prompt-${i}`, timestamp: at(base), message: { role: 'user', content: 'test' } },
    { type: 'assistant', sessionId, timestamp: at(base + 100), message: {
      id: `provider-${i}`, model: 'auto', role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn',
    } },
    { type: 'progress', timestamp: at(base + 200), data: { hookEvent: 'Stop' } },
  ]);
  const jsonl = (records: object[]) => records.map(row => JSON.stringify(row)).join('\n') + '\n';
  await fs.writeFile(transcript, jsonl(rows.slice(0, 1)));

  const output = new MockFlusher();
  const manager = new InputManager();
  manager.setFlusher(output);
  const state = new StateStore(path.join(fixture.home, 'state.json'));
  await state.load();
  const input = new QoderTraceInput({
    stateStore: state, dataDir: fixture.home, logDir: path.join(fixture.home, 'history'), pollIntervalMs: 60_000,
  });
  const collector = (input as any).transcriptSource.collector;
  collector.stableMs = 0;
  collector.settleMs = 0;
  manager.registerInput(input);
  try {
    expect(publishQoderWakeup({ session_id: sessionId, transcript_path: transcript, hook_event_name: 'UserPromptSubmit',
      cwd: fixture.home }, { dataDir: fixture.home, agentId: 'qoder' })).toBe(true);
    await input.start();
    await (input as any).cyclePromise;
    await fs.appendFile(transcript, jsonl(rows.slice(1)));
    expect(publishQoderWakeup({ session_id: sessionId, transcript_path: transcript, hook_event_name: 'Stop',
      cwd: fixture.home }, { dataDir: fixture.home, agentId: 'qoder' })).toBe(true);
    await vi.waitFor(async () => {
      await (input as any).runCycle();
      expect(output.batchCalls.flat().filter(row => row['event.name'] === 'llm.response')).toHaveLength(2);
    }, { timeout: 4_500, interval: 200 });
  } finally {
    await manager.stopAll();
  }

  const entries = output.batchCalls.flat();
  expect(entries.filter(row => row['event.name'] === 'llm.request').map(row => row['gen_ai.request.model']))
    .toEqual(['qmodel_latest', undefined]);
  for (const row of entries.filter(row => row['event.name'] === 'llm.response')) {
    expect(row['gen_ai.agent.type']).toBe('qoder-idea');
    expect(row['gen_ai.response.model']).toBeUndefined();
    expect(row['gen_ai.usage.input_tokens']).toBeUndefined();
    expect(row['gen_ai.usage.output_tokens']).toBeUndefined();
  }
});
