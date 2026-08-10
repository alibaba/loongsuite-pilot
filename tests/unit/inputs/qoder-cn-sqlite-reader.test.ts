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

/** Standalone-app layout: <app-support>/<dirName>/SharedClientCache/cache/db/local.db */
function appSupportDbPath(dirName = 'QoderCN'): string {
  const root = process.platform === 'darwin'
    ? path.join(tmpHome, 'Library', 'Application Support')
    : process.platform === 'win32'
      ? path.join(tmpHome, 'AppData', 'Roaming')
      : path.join(tmpHome, '.config');
  return path.join(root, dirName, 'SharedClientCache', 'cache', 'db', 'local.db');
}

/** IDE plugin layout: ~/.qoder-cn/shared_client/cache/db/local.db (probed first) */
function sharedClientDbPath(): string {
  return path.join(tmpHome, '.qoder-cn', 'shared_client', 'cache', 'db', 'local.db');
}

async function createDb(p: string): Promise<string> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await createSchema(p);
  return p;
}

// On Windows the reader resolves app-support from %APPDATA%; redirect it into the temp home.
const originalAppData = process.env.APPDATA;

let dbPath: string;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'qodercn-sqlite-test-'));
  if (process.platform === 'win32') {
    process.env.APPDATA = path.join(tmpHome, 'AppData', 'Roaming');
  }
  // Default fixture uses the standalone-app layout (the layout originally supported).
  dbPath = await createDb(appSupportDbPath());
});

afterEach(async () => {
  if (process.platform === 'win32') {
    if (originalAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = originalAppData;
  }
  try { await fs.rm(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('readSqliteTokensForSession (qoder-cn)', () => {
  it('returns an empty result when no candidate DB is accessible', async () => {
    await fs.rm(dbPath, { force: true });
    const result = await readSqliteTokensForSession('sess-x');
    expect(result.rows).toEqual([]);
    expect(result.matchedDbPath).toBeNull();
  });

  it('maps token_info, message_id, session_id, model_info to SqliteTokenData', async () => {
    await insertRow(dbPath, {
      id: 'msg-1', session_id: 'sess-1', request_id: 'req-1', role: 'assistant',
      token_info: JSON.stringify({ prompt_tokens: 100, completion_tokens: 20, cached_tokens: 80 }),
      model_info: JSON.stringify({ model_key: 'qwen-plus' }),
      gmt_create: 1_780_000_000_000,
    });

    const { rows } = await readSqliteTokensForSession('sess-1');
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

    const { rows } = await readSqliteTokensForSession('sess-2');
    expect(rows[0].model).toBe('auto');
  });

  it('filters out rows with both token counts zero', async () => {
    await insertRow(dbPath, {
      id: 'msg-3', session_id: 'sess-3', request_id: 'req-3', role: 'assistant',
      token_info: JSON.stringify({ prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0 }),
      gmt_create: 1_780_000_002_000,
    });
    const result = await readSqliteTokensForSession('sess-3');
    expect(result.rows).toEqual([]);
    expect(result.matchedDbPath).toBeNull();
  });

  it('ignores non-assistant rows', async () => {
    await insertRow(dbPath, {
      id: 'msg-4', session_id: 'sess-4', request_id: 'req-4', role: 'user',
      token_info: JSON.stringify({ prompt_tokens: 5, completion_tokens: 5, cached_tokens: 0 }),
      gmt_create: 1_780_000_003_000,
    });
    expect((await readSqliteTokensForSession('sess-4')).rows).toEqual([]);
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

    const { rows } = await readSqliteTokensForSession('sess-5');
    expect(rows.map(r => r.messageId)).toEqual(['msg-5b', 'msg-5a']);
  });
});

describe('readSqliteTokensForSession candidate probing (qoder-cn)', () => {
  it('reads tokens from the IDE plugin layout when it is the only layout present', async () => {
    await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
    const pluginDb = await createDb(sharedClientDbPath());
    await insertRow(pluginDb, {
      id: 'msg-p', session_id: 'sess-plugin', request_id: 'req-p', role: 'assistant',
      token_info: JSON.stringify({ prompt_tokens: 11, completion_tokens: 3, cached_tokens: 0 }),
      gmt_create: 1_780_000_010_000,
    });

    const result = await readSqliteTokensForSession('sess-plugin');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].inputTokens).toBe(11);
    expect(result.matchedDbPath).toBe(pluginDb);
  });

  it('reads tokens from the standalone-app layout when it is the only layout present', async () => {
    await insertRow(dbPath, {
      id: 'msg-s', session_id: 'sess-standalone', request_id: 'req-s', role: 'assistant',
      token_info: JSON.stringify({ prompt_tokens: 22, completion_tokens: 4, cached_tokens: 0 }),
      gmt_create: 1_780_000_011_000,
    });

    const result = await readSqliteTokensForSession('sess-standalone');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].inputTokens).toBe(22);
    expect(result.matchedDbPath).toBe(dbPath);
  });

  it('reads tokens from the spaced app-support directory variant', async () => {
    await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
    const spacedDb = await createDb(appSupportDbPath('Qoder CN'));
    await insertRow(spacedDb, {
      id: 'msg-sp', session_id: 'sess-spaced', request_id: 'req-sp', role: 'assistant',
      token_info: JSON.stringify({ prompt_tokens: 66, completion_tokens: 8, cached_tokens: 0 }),
      gmt_create: 1_780_000_016_000,
    });

    const result = await readSqliteTokensForSession('sess-spaced');
    expect(result.rows).toHaveLength(1);
    expect(result.matchedDbPath).toBe(spacedDb);
  });

  it('picks the candidate that actually holds the session when both layouts exist', async () => {
    const pluginDb = await createDb(sharedClientDbPath());
    // Target session lives only in the standalone-app DB.
    await insertRow(dbPath, {
      id: 'msg-only', session_id: 'sess-only-standalone', request_id: 'req-only', role: 'assistant',
      token_info: JSON.stringify({ prompt_tokens: 33, completion_tokens: 5, cached_tokens: 0 }),
      gmt_create: 1_780_000_012_000,
    });
    // Unrelated session in the plugin DB, which is probed first.
    await insertRow(pluginDb, {
      id: 'msg-other', session_id: 'sess-unrelated', request_id: 'req-other', role: 'assistant',
      token_info: JSON.stringify({ prompt_tokens: 99, completion_tokens: 9, cached_tokens: 0 }),
      gmt_create: 1_780_000_013_000,
    });

    const result = await readSqliteTokensForSession('sess-only-standalone');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].inputTokens).toBe(33);
    expect(result.matchedDbPath).toBe(dbPath);
  });

  it('continues past a readable candidate that returns zero rows for the session', async () => {
    // Plugin DB is probed first: valid schema, but no rows at all.
    await createDb(sharedClientDbPath());
    await insertRow(dbPath, {
      id: 'msg-z', session_id: 'sess-zero', request_id: 'req-z', role: 'assistant',
      token_info: JSON.stringify({ prompt_tokens: 44, completion_tokens: 6, cached_tokens: 0 }),
      gmt_create: 1_780_000_014_000,
    });

    const result = await readSqliteTokensForSession('sess-zero');
    expect(result.rows).toHaveLength(1);
    expect(result.matchedDbPath).toBe(dbPath);
  });

  it('continues past a candidate whose query throws', async () => {
    // Plugin DB exists but is not a valid SQLite file, so querying it rejects.
    const brokenDb = sharedClientDbPath();
    await fs.mkdir(path.dirname(brokenDb), { recursive: true });
    await fs.writeFile(brokenDb, 'not a sqlite database');
    await insertRow(dbPath, {
      id: 'msg-b', session_id: 'sess-broken', request_id: 'req-b', role: 'assistant',
      token_info: JSON.stringify({ prompt_tokens: 55, completion_tokens: 7, cached_tokens: 0 }),
      gmt_create: 1_780_000_015_000,
    });

    const result = await readSqliteTokensForSession('sess-broken');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].inputTokens).toBe(55);
    expect(result.matchedDbPath).toBe(dbPath);
  });

  it('does not throw when every candidate is inaccessible', async () => {
    await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
    await expect(readSqliteTokensForSession('sess-none')).resolves.toEqual({
      rows: [],
      matchedDbPath: null,
    });
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
