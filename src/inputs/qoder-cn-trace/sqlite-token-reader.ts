import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import sqlite3 from 'sqlite3';
import { resolveHome } from '../../utils/fs-utils.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('QoderCnSqliteTokenReader');

export interface SqliteTokenData {
  requestId: string;
  gmtCreate: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export async function readSqliteTokensForSession(sessionId: string): Promise<SqliteTokenData[]> {
  const dbPath = resolveQoderCnDbPath();
  if (!dbPath) return [];

  const sql = `
    SELECT request_id, gmt_create, token_info
    FROM chat_message
    WHERE session_id = ?
      AND role = 'assistant'
      AND token_info IS NOT NULL
      AND token_info != ''
      AND json_valid(token_info)
    ORDER BY gmt_create ASC
  `;

  let rows: Array<{ request_id: string; gmt_create: number; token_info: string }>;
  try {
    rows = await queryReadonly(dbPath, sql, [sessionId]);
  } catch (err) {
    logger.debug('sqlite query failed', { sessionId, error: String(err) });
    return [];
  }

  const results: SqliteTokenData[] = [];
  for (const row of rows) {
    const info = parseTokenInfo(row.token_info);
    if (!info) continue;
    results.push({
      requestId: row.request_id ?? '',
      gmtCreate: row.gmt_create,
      inputTokens: info.promptTokens,
      outputTokens: info.completionTokens,
      cacheReadTokens: info.cachedTokens,
    });
  }
  return results;
}

function resolveQoderCnDbPath(): string | null {
  const appdata = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  const candidates = process.platform === 'darwin'
    ? [resolveHome('~/Library/Application Support/QoderCN/SharedClientCache/cache/db/local.db')]
    : process.platform === 'win32'
      ? [path.join(appdata, 'QoderCN', 'SharedClientCache', 'cache', 'db', 'local.db')]
      : [resolveHome('~/.config/QoderCN/SharedClientCache/cache/db/local.db')];

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function parseTokenInfo(raw: string): { promptTokens: number; completionTokens: number; cachedTokens: number } | null {
  try {
    const obj = JSON.parse(raw);
    const pt = typeof obj.prompt_tokens === 'number' ? obj.prompt_tokens : 0;
    const ct = typeof obj.completion_tokens === 'number' ? obj.completion_tokens : 0;
    const cached = typeof obj.cached_tokens === 'number' ? obj.cached_tokens : 0;
    if (pt === 0 && ct === 0) return null;
    return { promptTokens: pt, completionTokens: ct, cachedTokens: cached };
  } catch {
    return null;
  }
}

function queryReadonly<T>(dbPath: string, sql: string, params: unknown[]): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (openErr) => {
      if (openErr) { reject(openErr); return; }
      db.all(sql, params, (queryErr: Error | null, rows: T[]) => {
        db.close((closeErr) => {
          if (closeErr) logger.debug('sqlite close warning', { error: String(closeErr) });
          if (queryErr) { reject(queryErr); return; }
          resolve(rows);
        });
      });
    });
  });
}
