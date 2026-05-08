import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import sqlite3 from 'sqlite3';
import { CollectionMethod, ClientType } from '../../../src/types/index.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { QoderSqliteInput } from '../../../src/inputs/qoder-sqlite/qoder-sqlite-input.js';
import { InputManager } from '../../../src/core/input-manager.js';
import { MultiFlusher } from '../../../src/flushers/multi-flusher.js';
import { serialiseLogEntry } from '../../../src/normalization/entry-builder.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';
import { MockFlusher } from '../../helpers/mock-flusher.js';

describe('QoderSqliteInput', () => {
  let tmpDir: string;
  let dbPath: string;
  let stateStore: MockStateStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qoder-sqlite-test-'));
    dbPath = path.join(tmpDir, 'local.db');
    stateStore = new MockStateStore();
    await createChatMessageDb(dbPath);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('has correct identity and collection method', () => {
    const input = makeInput();

    expect(input.id).toBe('qoder-sqlite');
    expect(input.agentType).toBe(ClientType.Qoder);
    expect(input.collectionMethod).toBe(CollectionMethod.SqlitePolling);
  });

  it('maps token_info to AgentActivityEntry usage fields', async () => {
    const gmtCreate = 1_777_659_871_533;
    await insertChatMessage(dbPath, {
      id: 'message-1',
      session_id: 'session-1',
      request_id: 'request-1',
      role: 'assistant',
      token_info: JSON.stringify({
        prompt_tokens: 22030,
        completion_tokens: 163,
        cached_tokens: 21814,
        max_input_tokens: 180000,
      }),
      model_info: '{"model_key":"qmodel"}',
      content: 'do not collect',
      summary: 'do not collect',
      tool_result: 'do not collect',
      extra: 'do not collect',
      gmt_create: gmtCreate,
    });

    stateStore.setRowId('qoder-sqlite', 0);
    const entries = await collectOnce(makeInput());

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      'event.id': 'message-1',
      'event.name': 'llm.response',
      'gen_ai.agent.type': ClientType.Qoder,
      'gen_ai.session.id': 'session-1',
      'gen_ai.request.model': 'unknown',
      'gen_ai.response.model': 'unknown',
      'gen_ai.usage.input_tokens': 22030,
      'gen_ai.usage.output_tokens': 163,
      'gen_ai.usage.cache_read.input_tokens': 21814,
      'gen_ai.usage.total_tokens': 22193,
      time_unix_nano: `${gmtCreate}000000`,
    });
    expect(entries[0]?.observed_time_unix_nano).not.toBe(`${gmtCreate}000000`);
    expect(entries[0]?.['client.channel']).toBeUndefined();
    expect(entries[0]?.['agent.source']).toBe('qoder-sqlite-chat-message');
    expect(entries[0]?.['agent.rowid']).toBe(1);
    expect(entries[0]?.['agent.message_id']).toBe('message-1');
    expect(entries[0]?.['agent.request_id']).toBe('request-1');
    expect(entries[0]?.['agent.max_input_tokens']).toBe(180000);
    expect(entries[0]?.['gen_ai.request.id']).toBeUndefined();
    expect(entries[0]?.['agent.token_info']).toBeUndefined();
  });

  it('excludes non-usage chat_message fields from emitted attributes', async () => {
    await insertChatMessage(dbPath, {
      id: 'message-2',
      token_info: JSON.stringify({ prompt_tokens: 1, completion_tokens: 2, cached_tokens: 3 }),
      model_info: '{"model_key":"qmodel"}',
      content: 'secret content',
      summary: 'secret summary',
      tool_result: 'secret tool result',
      extra: 'secret extra',
      gmt_create: 1_777_659_871_533,
    });

    const [entry] = await collectOnce(makeInput());
    expect(entry?.['agent.model_info']).toBeUndefined();
    expect(entry?.['agent.content']).toBeUndefined();
    expect(entry?.['agent.summary']).toBeUndefined();
    expect(entry?.['agent.tool_result']).toBeUndefined();
    expect(entry?.['agent.extra']).toBeUndefined();
  });

  it('tracks rowid cursor and avoids duplicate emission', async () => {
    await insertChatMessage(dbPath, {
      id: 'message-3',
      token_info: JSON.stringify({ prompt_tokens: 10, completion_tokens: 5 }),
      gmt_create: 1_777_659_871_533,
    });

    stateStore.setRowId('qoder-sqlite', 0);
    const firstEntries = await collectOnce(makeInput());
    const secondEntries = await collectOnce(makeInput());

    expect(firstEntries).toHaveLength(1);
    expect(stateStore.getRowId('qoder-sqlite')).toBe(1);
    expect(secondEntries).toHaveLength(0);
  });

  it('baselines fresh state and skips historical eligible rows', async () => {
    await insertChatMessage(dbPath, {
      id: 'historical-1',
      token_info: JSON.stringify({ prompt_tokens: 10, completion_tokens: 5 }),
      gmt_create: 1_777_659_871_533,
    });
    await insertChatMessage(dbPath, {
      id: 'historical-2',
      token_info: JSON.stringify({ prompt_tokens: 20, completion_tokens: 7 }),
      gmt_create: 1_777_659_871_534,
    });

    const entries = await collectOnce(makeInput());

    expect(entries).toHaveLength(0);
    expect(stateStore.getRowId('qoder-sqlite')).toBe(2);
  });

  it('emits rows inserted after startup baseline', async () => {
    await insertChatMessage(dbPath, {
      id: 'historical',
      token_info: JSON.stringify({ prompt_tokens: 10, completion_tokens: 5 }),
      gmt_create: 1_777_659_871_533,
    });

    const input = makeInput();
    const entries: AgentActivityEntry[] = [];
    input.on('entries', (batch: AgentActivityEntry[]) => entries.push(...batch));
    await input.start();
    expect(entries).toHaveLength(0);
    expect(stateStore.getRowId('qoder-sqlite')).toBe(1);

    await insertChatMessage(dbPath, {
      id: 'new-after-baseline',
      token_info: JSON.stringify({ prompt_tokens: 3, completion_tokens: 4 }),
      gmt_create: 1_777_659_871_534,
    });

    await input.stop();
    const input2 = makeInput();
    const newEntries: AgentActivityEntry[] = [];
    input2.on('entries', (batch: AgentActivityEntry[]) => newEntries.push(...batch));
    await input2.start();
    await input2.stop();

    expect(newEntries).toHaveLength(1);
    expect(newEntries[0]?.['agent.message_id']).toBe('new-after-baseline');
    expect(stateStore.getRowId('qoder-sqlite')).toBe(2);
  });

  it('preserves existing rowid state and collects rows after that cursor', async () => {
    await insertChatMessage(dbPath, {
      id: 'already-collected',
      token_info: JSON.stringify({ prompt_tokens: 1, completion_tokens: 1 }),
      gmt_create: 1_777_659_871_533,
    });
    await insertChatMessage(dbPath, {
      id: 'arrived-while-stopped',
      token_info: JSON.stringify({ prompt_tokens: 2, completion_tokens: 2 }),
      gmt_create: 1_777_659_871_534,
    });
    stateStore.setRowId('qoder-sqlite', 1);

    const entries = await collectOnce(makeInput());

    expect(entries).toHaveLength(1);
    expect(entries[0]?.['agent.message_id']).toBe('arrived-while-stopped');
    expect(stateStore.getRowId('qoder-sqlite')).toBe(2);
  });

  it('baselines using only eligible token rows', async () => {
    await insertChatMessage(dbPath, {
      id: 'empty-token',
      token_info: '',
      gmt_create: 1_777_659_871_533,
    });
    await insertChatMessage(dbPath, {
      id: 'invalid-token',
      token_info: 'not json',
      gmt_create: 1_777_659_871_534,
    });
    await insertChatMessage(dbPath, {
      id: 'eligible-token',
      token_info: JSON.stringify({ prompt_tokens: 3, completion_tokens: 4 }),
      gmt_create: 1_777_659_871_535,
    });

    const entries = await collectOnce(makeInput());

    expect(entries).toHaveLength(0);
    expect(stateStore.getRowId('qoder-sqlite')).toBe(3);
  });

  it('skips empty and invalid token_info rows', async () => {
    await insertChatMessage(dbPath, {
      id: 'message-empty',
      token_info: '',
      gmt_create: 1_777_659_871_533,
    });
    await insertChatMessage(dbPath, {
      id: 'message-invalid',
      token_info: 'not json',
      gmt_create: 1_777_659_871_534,
    });
    await insertChatMessage(dbPath, {
      id: 'message-valid',
      token_info: JSON.stringify({ prompt_tokens: 3, completion_tokens: 4 }),
      gmt_create: 1_777_659_871_535,
    });

    stateStore.setRowId('qoder-sqlite', 0);
    const entries = await collectOnce(makeInput());

    expect(entries).toHaveLength(1);
    expect(entries[0]?.['agent.message_id']).toBe('message-valid');
    expect(stateStore.getRowId('qoder-sqlite')).toBe(3);
  });

  it('routes emitted entries through the same multi-flusher contract', async () => {
    await insertChatMessage(dbPath, {
      id: 'message-flusher',
      session_id: 'session-flusher',
      token_info: JSON.stringify({
        prompt_tokens: 11,
        completion_tokens: 7,
        cached_tokens: 5,
      }),
      gmt_create: 1_777_659_871_533,
    });
    stateStore.setRowId('qoder-sqlite', 0);

    const input = makeInput();
    const jsonlLikeFlusher = new MockFlusher('jsonl');
    const slsLikeFlusher = new MockFlusher('sls');
    const inputManager = new InputManager();
    inputManager.setFlusher(new MultiFlusher([jsonlLikeFlusher, slsLikeFlusher]));
    inputManager.registerInput(input);

    await input.start();
    await input.stop();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(jsonlLikeFlusher.batchCalls).toHaveLength(1);
    expect(slsLikeFlusher.batchCalls).toHaveLength(1);
    expect(jsonlLikeFlusher.batchCalls[0]?.[0]).toEqual(slsLikeFlusher.batchCalls[0]?.[0]);

    const serialized = serialiseLogEntry(jsonlLikeFlusher.batchCalls[0]![0]!);
    expect(serialized['gen_ai.usage.input_tokens']).toBe('11');
    expect(serialized['gen_ai.usage.output_tokens']).toBe('7');
    expect(serialized['gen_ai.usage.cache_read.input_tokens']).toBe('5');
    expect(serialized['agent.source']).toBe('qoder-sqlite-chat-message');
  });

  function makeInput(): QoderSqliteInput {
    return new QoderSqliteInput({
      stateStore: stateStore as any,
      dbPath,
      pollIntervalMs: 60_000,
    });
  }
});

async function collectOnce(input: QoderSqliteInput): Promise<AgentActivityEntry[]> {
  const entries: AgentActivityEntry[] = [];
  input.on('entries', (batch: AgentActivityEntry[]) => entries.push(...batch));
  await input.start();
  await input.stop();
  return entries;
}

async function createChatMessageDb(dbPath: string): Promise<void> {
  await execSql(dbPath, `
    CREATE TABLE chat_message (
      id varchar(64) PRIMARY KEY,
      session_id VARCHAR(64),
      request_id VARCHAR(64),
      role VARCHAR(64),
      content TEXT,
      summary TEXT,
      summary_modified INTEGER,
      summary_trigger INTEGER DEFAULT 0,
      tool_result TEXT,
      token_info TEXT,
      model_info TEXT,
      extra TEXT DEFAULT '',
      gmt_create INTEGER
    )
  `);
}

async function insertChatMessage(
  dbPath: string,
  row: {
    id: string;
    session_id?: string;
    request_id?: string;
    role?: string;
    content?: string;
    summary?: string;
    tool_result?: string;
    token_info: string;
    model_info?: string;
    extra?: string;
    gmt_create: number;
  },
): Promise<void> {
  await execSql(
    dbPath,
    `
      INSERT INTO chat_message (
        id,
        session_id,
        request_id,
        role,
        content,
        summary,
        tool_result,
        token_info,
        model_info,
        extra,
        gmt_create
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      row.id,
      row.session_id ?? null,
      row.request_id ?? null,
      row.role ?? null,
      row.content ?? null,
      row.summary ?? null,
      row.tool_result ?? null,
      row.token_info,
      row.model_info ?? null,
      row.extra ?? '',
      row.gmt_create,
    ],
  );
}

function execSql(dbPath: string, sql: string, params: unknown[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    let db: sqlite3.Database;
    db = new sqlite3.Database(dbPath, (openErr) => {
      if (openErr) {
        reject(openErr);
        return;
      }

      db.run(sql, params, (runErr: Error | null) => {
        db.close((closeErr) => {
          if (runErr) {
            reject(runErr);
            return;
          }
          if (closeErr) {
            reject(closeErr);
            return;
          }
          resolve();
        });
      });
    });
  });
}
