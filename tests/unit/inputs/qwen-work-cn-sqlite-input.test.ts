import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import sqlite3 from 'sqlite3';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { ClientType, CollectionMethod } from '../../../src/types/index.js';
import { QwenWorkCNSqliteInput } from '../../../src/inputs/qwen-work-cn/qwen-work-cn-sqlite-input.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';

class TestInput extends QwenWorkCNSqliteInput {
  collectNow(): Promise<AgentActivityEntry[]> { return this.collect(); }
}

describe('QwenWorkCNSqliteInput', () => {
  let dir: string;
  let dbPath: string;
  let state: MockStateStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-work-cn-db-'));
    dbPath = path.join(dir, 'agents.db');
    state = new MockStateStore();
    await exec(`
      CREATE TABLE sub_chats (id TEXT PRIMARY KEY, session_id TEXT, model_level TEXT);
      CREATE TABLE messages (id TEXT PRIMARY KEY, sub_chat_id TEXT, sequence INTEGER, role TEXT, parts TEXT, updated_at INTEGER);
    `);
    state.update('qwen-work-cn-sqlite', { extra: { lastUpdatedAt: 0 } });
  });

  afterEach(async () => fs.rm(dir, { recursive: true, force: true }));

  it('maps QwenWorkCN user and tool rows without QoderWork inputs', async () => {
    await exec(`
      INSERT INTO sub_chats VALUES ('sc-1', 'sess-1', 'qwen3-coder');
      INSERT INTO messages VALUES ('m-user', 'sc-1', 0, 'user', '[{"type":"text","text":"implement it"}]', 1770000001);
      INSERT INTO messages VALUES ('m-tool', 'sc-1', 1, 'assistant', '[{"type":"tool-Read","toolCallId":"call-1","toolName":"Read","output":{"ok":true}}]', 1770000002);
    `);
    const input = new TestInput({ stateStore: state as never, dbPath });
    const entries = await input.collectNow();

    expect(input.id).toBe('qwen-work-cn-sqlite');
    expect(input.collectionMethod).toBe(CollectionMethod.SqlitePolling);
    expect(entries.map(entry => entry['event.name'])).toEqual(['llm.request', 'tool.result']);
    expect(entries.every(entry => entry['gen_ai.agent.type'] === ClientType.QwenWorkCN)).toBe(true);
    expect(entries[0]!['gen_ai.input.messages_delta']).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'implement it' }] },
    ]);
    expect(entries[1]!['gen_ai.tool.name']).toBe('Read');
    expect(entries[1]!['gen_ai.tool.call.result']).toEqual({ ok: true });
    expect(entries.every(entry => entry['agent.source'] === 'qwen-work-cn-sqlite')).toBe(true);
  });

  it('continues across a batch boundary when rows share updated_at', async () => {
    await exec(`INSERT INTO sub_chats VALUES ('sc-1', 'sess-1', 'qwen3-coder');`);
    const inserts = Array.from({ length: 1001 }, (_, index) => (
      `INSERT INTO messages VALUES ('m-${index}', 'sc-1', ${index}, 'user', '[{"type":"text","text":"prompt ${index}"}]', 1770000001);`
    )).join('\n');
    await exec(inserts);

    const input = new TestInput({ stateStore: state as never, dbPath });
    expect((await input.collectNow())).toHaveLength(1000);
    expect((await input.collectNow())).toHaveLength(1);
    expect(await input.collectNow()).toEqual([]);
  });

  it('collects a row inserted later with the same updated_at', async () => {
    await exec(`
      INSERT INTO sub_chats VALUES ('sc-1', 'sess-1', 'qwen3-coder');
      INSERT INTO messages VALUES ('m-1', 'sc-1', 0, 'user', '[{"type":"text","text":"first"}]', 1770000001);
    `);
    const input = new TestInput({ stateStore: state as never, dbPath });
    expect((await input.collectNow()).map(entry => entry['agent.message_id'])).toEqual(['m-1']);

    await exec(`INSERT INTO messages VALUES ('m-2', 'sc-1', 1, 'user', '[{"type":"text","text":"second"}]', 1770000001);`);
    expect((await input.collectNow()).map(entry => entry['agent.message_id'])).toEqual(['m-2']);
  });

  function exec(sql: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const db = new sqlite3.Database(dbPath);
      db.exec(sql, error => {
        db.close();
        if (error) reject(error); else resolve();
      });
    });
  }
});
