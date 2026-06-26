import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import sqlite3 from 'sqlite3';

let tmpHome: string = os.tmpdir();

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: () => tmpHome,
    default: { ...actual, homedir: () => tmpHome },
  };
});

const { readSqliteTokensForSession } = await import('../../../src/inputs/qoder-cn-trace/sqlite-token-reader.js');

let dbPath: string;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'qodercn-sqlite-test-'));

  // The reader resolves ~/Library/Application Support/QoderCN/SharedClientCache/cache/db/local.db on darwin.
  // For non-darwin platforms it uses ~/.config/QoderCN/.../local.db. We always cover the darwin path
  // (covers macOS CI / local dev); on Linux CI the readSqliteTokensForSession will probe both candidates.
  const dbDir = process.platform === 'darwin'
    ? path.join(tmpHome, 'Library', 'Application Support', 'QoderCN', 'SharedClientCache', 'cache', 'db')
    : path.join(tmpHome, '.config', 'QoderCN', 'SharedClientCache', 'cache', 'db');
  await fs.mkdir(dbDir, { recursive: true });
  dbPath = path.join(dbDir, 'local.db');
  await createSchema(dbPath);
});

afterEach(async () => {
  try { await fs.rm(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('readSqliteTokensForSession (qoder-cn)', () => {
  it('returns empty array when DB missing', async () => {
    await fs.rm(dbPath, { force: true });
    expect(await readSqliteTokensForSession('sess-x')).toEqual([]);
  });

  it('maps token_info, message_id, session_id, model_info to SqliteTokenData', async () => {
    await insertRow(dbPath, {
      id: 'msg-1', session_id: 'sess-1', request_id: 'req-1', role: 'assistant',
      token_info: JSON.stringify({ prompt_tokens: 100, completion_tokens: 20, cached_tokens: 80 }),
      model_info: JSON.stringify({ model_key: 'qwen-plus' }),
      gmt_create: 1_780_000_000_000,
    });

    const rows = await readSqliteTokensForSession('sess-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: 'sess-1',
      messageId: 'msg-1',
      requestId: 'req-1',
      gmtCreate: 1_780_000_000_000,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 80,
      model: 'qwen-plus',
    });
  });

  it('falls back to chat_record.extra.modelConfig.key when model_info missing model_key', async () => {
    await insertRecord(dbPath, {
      request_id: 'req-2',
      session_id: 'sess-2',
      extra: JSON.stringify({ modelConfig: { key: 'auto' } }),
    });
    await insertRow(dbPath, {
      id: 'msg-2', session_id: 'sess-2', request_id: 'req-2', role: 'assistant',
      token_info: JSON.stringify({ prompt_tokens: 1, completion_tokens: 2, cached_tokens: 0 }),
      model_info: '{"foo":"bar"}',
      gmt_create: 1_780_000_001_000,
    });

    const rows = await readSqliteTokensForSession('sess-2');
    expect(rows[0].model).toBe('auto');
  });

  it('filters out rows with both token counts zero', async () => {
    await insertRow(dbPath, {
      id: 'msg-3', session_id: 'sess-3', request_id: 'req-3', role: 'assistant',
      token_info: JSON.stringify({ prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0 }),
      gmt_create: 1_780_000_002_000,
    });
    expect(await readSqliteTokensForSession('sess-3')).toEqual([]);
  });

  it('ignores non-assistant rows', async () => {
    await insertRow(dbPath, {
      id: 'msg-4', session_id: 'sess-4', request_id: 'req-4', role: 'user',
      token_info: JSON.stringify({ prompt_tokens: 5, completion_tokens: 5, cached_tokens: 0 }),
      gmt_create: 1_780_000_003_000,
    });
    expect(await readSqliteTokensForSession('sess-4')).toEqual([]);
  });

  it('orders results by gmt_create ascending', async () => {
    await insertRow(dbPath, {
      id: 'msg-5a', session_id: 'sess-5', request_id: 'req-5a', role: 'assistant',
      token_info: JSON.stringify({ prompt_tokens: 10, completion_tokens: 1, cached_tokens: 0 }),
      gmt_create: 1_780_000_005_000,
    });
    await insertRow(dbPath, {
      id: 'msg-5b', session_id: 'sess-5', request_id: 'req-5b', role: 'assistant',
      token_info: JSON.stringify({ prompt_tokens: 20, completion_tokens: 2, cached_tokens: 0 }),
      gmt_create: 1_780_000_004_000,
    });

    const rows = await readSqliteTokensForSession('sess-5');
    expect(rows.map(r => r.messageId)).toEqual(['msg-5b', 'msg-5a']);
  });
});

// --- Test helpers ---

async function createSchema(p: string): Promise<void> {
  await execSql(p, `
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
  await execSql(p, `
    CREATE TABLE chat_record (
      request_id varchar(64) PRIMARY KEY,
      session_id varchar(64),
      extra TEXT DEFAULT ''
    )
  `);
}

async function insertRow(p: string, row: {
  id: string;
  session_id: string;
  request_id: string;
  role: string;
  token_info: string;
  model_info?: string;
  gmt_create: number;
}): Promise<void> {
  await execSql(
    p,
    `INSERT INTO chat_message (id, session_id, request_id, role, token_info, model_info, gmt_create)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.session_id, row.request_id, row.role, row.token_info, row.model_info ?? null, row.gmt_create],
  );
}

async function insertRecord(p: string, row: {
  request_id: string;
  session_id: string;
  extra: string;
}): Promise<void> {
  await execSql(
    p,
    `INSERT INTO chat_record (request_id, session_id, extra) VALUES (?, ?, ?)`,
    [row.request_id, row.session_id, row.extra],
  );
}

function execSql(dbPath: string, sql: string, params: unknown[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (openErr) => {
      if (openErr) { reject(openErr); return; }
      db.run(sql, params, (runErr: Error | null) => {
        db.close((closeErr) => {
          if (runErr) { reject(runErr); return; }
          if (closeErr) { reject(closeErr); return; }
          resolve();
        });
      });
    });
  });
}
