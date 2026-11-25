import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExportResultCode } from '@opentelemetry/core';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { QoderTraceInput } from '../../src/inputs/qoder-trace/qoder-trace-input.js';
import { readSqliteTokensForSession } from '../../src/inputs/qoder-trace/sqlite-token-reader.js';
import { StateStore } from '../../src/checkpoints/state-store.js';
import { InputManager } from '../../src/core/input-manager.js';
import { MultiFlusher } from '../../src/flushers/multi-flusher.js';
import { OtlpTraceFlusher } from '../../src/flushers/otlp-trace-flusher.js';
import { getTodayDateString } from '../../src/utils/fs-utils.js';
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

it.each([
  ['missing table', ''],
  ['missing model column', 'CREATE TABLE chat_record (session_id TEXT, request_id TEXT);'],
])('retains JetBrains token rows with a legacy schema: %s', async (_name, recordSchema) => {
  fixture.home = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-idea-legacy-model-'));
  const dbDir = path.join(fixture.home, '.qoder/shared_client/cache/db');
  await fs.mkdir(dbDir, { recursive: true });
  const Database = loadDatabaseSync();
  if (!Database) throw new Error('node:sqlite required');
  const dbPath = path.join(dbDir, 'local.db');
  const db = new Database(dbPath);
  try {
    db.exec(`${recordSchema}
      CREATE TABLE chat_message (id TEXT, role TEXT, gmt_create INTEGER, token_info TEXT, model_info TEXT, session_id TEXT, request_id TEXT)`);
    db.prepare('INSERT INTO chat_message VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('legacy-message', 'assistant', 100, '{"prompt_tokens":12,"completion_tokens":3}', '{"model_key":"legacy-model"}', 'legacy-session', 'legacy-request');
  } finally {
    db.close();
  }

  const result = await readSqliteTokensForSession('legacy-session');
  expect(result.matchedDbPath).toBe(dbPath);
  expect(result.rows).toEqual([expect.objectContaining({
    messageId: 'legacy-message', model: 'legacy-model', inputTokens: 12, outputTokens: 3,
  })]);
  expect(result.requestModels).toEqual([]);
});

it('keeps one token row per message and omits conflicting request models', async () => {
  fixture.home = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-idea-replayed-model-'));
  const dbDir = path.join(fixture.home, '.qoder/shared_client/cache/db');
  await fs.mkdir(dbDir, { recursive: true });
  const Database = loadDatabaseSync();
  if (!Database) throw new Error('node:sqlite required');
  const db = new Database(path.join(dbDir, 'local.db'));
  try {
    db.exec(`CREATE TABLE chat_record (session_id TEXT, request_id TEXT, extra TEXT);
      CREATE TABLE chat_message (id TEXT, role TEXT, gmt_create INTEGER, token_info TEXT, model_info TEXT, session_id TEXT, request_id TEXT)`);
    const record = db.prepare('INSERT INTO chat_record VALUES (?, ?, ?)');
    const message = db.prepare('INSERT INTO chat_message VALUES (?, ?, ?, ?, ?, ?, ?)');
    message.run('agreed-message', 'assistant', 100, '{"prompt_tokens":12,"completion_tokens":3}', null, 'session', 'agreed');
    message.run('ambiguous-message', 'assistant', 200, '{"prompt_tokens":19,"completion_tokens":5}', null, 'session', 'ambiguous');
    for (const [requestId, model] of [['agreed', 'auto'], ['agreed', 'auto'], ['ambiguous', 'fast'], ['ambiguous', 'auto']]) {
      record.run('session', requestId, JSON.stringify({ modelConfig: { key: model } }));
    }
    record.run('unrelated-session', 'agreed', '{"modelConfig":{"key":"fast"}}');
  } finally {
    db.close();
  }

  const result = await readSqliteTokensForSession('session');
  expect(result.rows.map(row => [row.messageId, row.inputTokens])).toEqual([
    ['agreed-message', 12], ['ambiguous-message', 19],
  ]);
  expect(result.requestModels).toEqual([
    { messageId: 'agreed-message', requestId: 'agreed', gmtCreate: 100, model: 'auto' },
  ]);
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

it.each([
  { read: 'first SQLite read', delayed: false, hookModel: 'auto', expectedModel: undefined },
  { read: 'SQLite retry', delayed: true, hookModel: 'auto', expectedModel: undefined },
  { read: 'recorded response model', delayed: false, hookModel: 'fixture-executed-model', expectedModel: 'fixture-executed-model' },
])('keeps request and response models separate through legacy Hook collection and export: $read', async ({
  delayed, hookModel, expectedModel,
}) => {
  fixture.home = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-idea-legacy-model-span-'));
  const dbDir = path.join(fixture.home, '.qoder/shared_client/cache/db');
  const logDir = path.join(fixture.home, 'history');
  await Promise.all([fs.mkdir(dbDir, { recursive: true }), fs.mkdir(logDir)]);
  const Database = loadDatabaseSync();
  if (!Database) throw new Error('node:sqlite required');
  const db = new Database(path.join(dbDir, 'local.db'));
  const sessionId = 'legacy-session';
  const responseAt = Date.now() - 100;
  const spans: ReadableSpan[] = [];
  const output = new MockFlusher();
  const otlp = new OtlpTraceFlusher({
    enabled: true, dataDir: fixture.home, serviceName: 'qoder-legacy-model-test',
    endpoints: [{ endpoint: 'http://127.0.0.1:4318/v1/traces', headers: {} }], protocol: 'http/protobuf',
  }, undefined, () => ({
    export(batch, callback) { spans.push(...batch); callback({ code: ExportResultCode.SUCCESS }); },
    shutdown: async () => {},
  }));
  const flusher = new MultiFlusher([output, otlp]);
  const manager = new InputManager();
  manager.setFlusher(flusher);
  try {
    db.exec(`CREATE TABLE chat_record (session_id TEXT, request_id TEXT, extra TEXT);
      CREATE TABLE chat_message (id TEXT, role TEXT, gmt_create INTEGER, token_info TEXT, model_info TEXT, session_id TEXT, request_id TEXT)`);
    // The IDE database supplies just the selection, never a response model or usage.
    db.prepare('INSERT INTO chat_message VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('legacy-message', 'assistant', responseAt, null, null, sessionId, 'legacy-request');
    const persistSelection = () => db.prepare('INSERT INTO chat_record VALUES (?, ?, ?)')
      .run(sessionId, 'legacy-request', '{"modelConfig":{"key":"fast"}}');
    if (!delayed) persistSelection();

    const common = {
      'gen_ai.agent.type': 'qoder-idea', 'gen_ai.session.id': sessionId, 'gen_ai.turn.id': 'legacy-turn',
      'gen_ai.request.model': 'auto', 'agent.transcript.cursor_mode': 'incremental',
    };
    const at = (ms: number) => String(BigInt(responseAt + ms) * 1_000_000n);
    const records = [
      { ...common, 'event.name': 'other', 'event.id': 'prompt', time_unix_nano: at(-200),
        'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: 'fixture prompt' }] }] },
      { ...common, 'event.name': 'llm.request', 'event.id': 'request', 'gen_ai.step.id': 'legacy-step', time_unix_nano: at(-100) },
      { ...common, 'event.name': 'llm.response', 'event.id': 'response', 'gen_ai.step.id': 'legacy-step', time_unix_nano: at(0),
        // Without the response ID, the compatibility input retries, then matches the exact record time.
        ...(delayed ? { 'agent.qoder.match_ts': responseAt } : { 'gen_ai.response.id': 'legacy-message' }),
        'gen_ai.response.model': hookModel, 'gen_ai.usage.input_tokens': 12, 'gen_ai.usage.output_tokens': 3,
        'gen_ai.response.finish_reasons': ['stop'], 'gen_ai.turn.end': true },
    ];
    const logName = `qoder-${getTodayDateString()}.jsonl`;
    const state = new StateStore(path.join(fixture.home, 'state.json'));
    await state.load();
    state.update('qoder-trace', { lastFile: logName, lastOffset: 0, extra: { hookHistoryInitialized: true } });
    await state.save();
    await fs.writeFile(path.join(logDir, logName), records.map(row => JSON.stringify(row)).join('\n') + '\n');

    const reads: string[] = [];
    class LegacyModelInput extends QoderTraceInput {
      protected override readIdeSqliteTokens(id: string) {
        reads.push(id);
        if (delayed && reads.length === 2) persistSelection();
        return super.readIdeSqliteTokens(id);
      }
    }
    const input = new LegacyModelInput({ stateStore: state, dataDir: fixture.home, logDir, pollIntervalMs: 60_000 });
    manager.registerInput(input);
    await input.start();
    await manager.stopAll();
    await flusher.flush();

    expect(reads).toEqual(delayed ? [sessionId, sessionId] : [sessionId]);
    const events = output.batchCalls.flat();
    const request = events.find(row => row['event.name'] === 'llm.request');
    const response = events.find(row => row['event.name'] === 'llm.response');
    expect(request?.['gen_ai.request.model']).toBe('fast');
    expect(response?.['gen_ai.request.model']).toBe('fast');
    const llms = spans.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM');
    expect(llms).toHaveLength(1);
    expect(llms[0].attributes).toMatchObject({
      'gen_ai.request.model': 'fast', 'gen_ai.usage.input_tokens': 12, 'gen_ai.usage.output_tokens': 3,
    });
    if (expectedModel === undefined) {
      expect(response).not.toHaveProperty('gen_ai.response.model');
      expect(llms[0].attributes).not.toHaveProperty('gen_ai.response.model');
    } else {
      expect(response?.['gen_ai.response.model']).toBe(expectedModel);
      expect(llms[0].attributes['gen_ai.response.model']).toBe(expectedModel);
    }
  } finally {
    await manager.stopAll();
    await flusher.shutdown();
    db.close();
  }
});
