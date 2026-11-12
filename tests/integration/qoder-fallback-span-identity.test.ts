import { expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { QoderCnSqliteInput } from '../../src/inputs/qoder-cn-sqlite/qoder-cn-sqlite-input.js';
import { StateStore } from '../../src/checkpoints/state-store.js';
import { InputManager } from '../../src/core/input-manager.js';
import { OtlpTraceFlusher } from '../../src/flushers/otlp-trace-flusher.js';
import { execSql, hasNodeSqlite } from '../helpers/sqlite-fixture.mjs';

it.skipIf(!hasNodeSqlite())('exports distinct fallback LLM spans through SQLite, InputManager and normal shutdown', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qoder-fallback-identity-'));
  const db = path.join(root, 'local.db');
  const state = new StateStore(path.join(root, 'state.json'));
  await state.load();
  execSql(db, 'CREATE TABLE chat_message (id TEXT, session_id TEXT, request_id TEXT, role TEXT, token_info TEXT, gmt_create INTEGER)');
  const baseline = new QoderCnSqliteInput({ stateStore: state, dbPath: db, pollIntervalMs: 60_000 });
  const spans: ReadableSpan[] = [];
  const flusher = new OtlpTraceFlusher({ enabled: true, serviceName: 'qoder-fallback-test', protocol: 'http/protobuf',
    endpoints: [{ endpoint: 'http://localhost:4318/v1/traces', headers: {} }] }, undefined,
  () => ({ export(batch, callback) { spans.push(...batch); callback({ code: 0 }); }, shutdown: async () => {} }));
  const manager = new InputManager(); manager.setFlusher(flusher);
  let shutdown = false;
  try {
    await baseline.start(); await baseline.stop();
    expect(state.get('qoder-cn-sqlite').lastRowId).toBe(0);
    for (let i = 1; i <= 2; i++) execSql(db,
      'INSERT INTO chat_message VALUES (?, ?, ?, ?, ?, ?)',
      [`message-${i}`, 'fallback-session', `request-${i}`, 'assistant',
        JSON.stringify({ prompt_tokens: i * 10, completion_tokens: i }), Date.now() - 60_000 + i]);
    const input = new QoderCnSqliteInput({ stateStore: state, dbPath: db, pollIntervalMs: 60_000 });
    manager.registerInput(input);
    await input.start(); await manager.stopAll();
    await flusher.shutdown(); shutdown = true;
    expect(state.get('qoder-cn-sqlite').lastRowId).toBe(2);
    const llms = spans.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM');
    expect(llms).toHaveLength(2);
    expect(new Set(llms.map(span => `${span.spanContext().traceId}:${span.spanContext().spanId}`)).size).toBe(2);
    expect(llms.map(span => span.attributes['gen_ai.usage.input_tokens']).sort()).toEqual([10, 20]);
    expect(llms.map(span => span.attributes['gen_ai.usage.output_tokens']).sort()).toEqual([1, 2]);
  } finally {
    await baseline.stop(); await manager.stopAll();
    if (!shutdown) await flusher.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});
