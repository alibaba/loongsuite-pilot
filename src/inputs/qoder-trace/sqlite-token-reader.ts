import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import sqlite3 from 'sqlite3';
import { resolveHome } from '../../utils/fs-utils.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('SqliteTokenReader');

export interface SqliteTokenData {
  sessionId?: string;
  requestId: string;
  messageId?: string;
  gmtCreate: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  model?: string;
}

export async function readSqliteTokensForSession(sessionId: string): Promise<SqliteTokenData[]> {
  const dbPath = resolveQoderDbPath();
  if (!dbPath) return [];

  const sql = `
    SELECT
      cm.id AS message_id,
      cm.session_id AS session_id,
      cm.request_id AS request_id,
      cm.gmt_create AS gmt_create,
      cm.token_info AS token_info,
      cm.model_info AS model_info,
      cr.extra AS record_extra
    FROM chat_message cm
    LEFT JOIN chat_record cr ON cr.request_id = cm.request_id
    WHERE cm.session_id = ?
      AND cm.role = 'assistant'
      AND cm.token_info IS NOT NULL
      AND cm.token_info != ''
      AND json_valid(cm.token_info)
    ORDER BY cm.gmt_create ASC
  `;

  let rows: Array<{
    message_id?: string;
    session_id?: string;
    request_id: string;
    gmt_create: number;
    token_info: string;
    model_info?: string | null;
    record_extra?: string | null;
  }>;
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
      sessionId: row.session_id ?? '',
      requestId: row.request_id ?? '',
      messageId: row.message_id ?? '',
      gmtCreate: row.gmt_create,
      inputTokens: info.promptTokens,
      outputTokens: info.completionTokens,
      cacheReadTokens: info.cachedTokens,
      model: parseModelKey(row.model_info) ?? parseRecordModelKey(row.record_extra),
    });
  }
  return results;
}

function resolveQoderDbPath(): string | null {
  // Qoder Desktop (Electron app) keeps SQLite under platform app-support.
  // Qoder for JetBrains shares state through ~/.qoder/shared_client/.
  const appdata = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  const candidates = process.platform === 'darwin'
    ? [
        resolveHome('~/Library/Application Support/Qoder/SharedClientCache/cache/db/local.db'),
        resolveHome('~/.qoder/shared_client/cache/db/local.db'),
      ]
    : process.platform === 'win32'
      ? [
          path.join(appdata, 'Qoder', 'SharedClientCache', 'cache', 'db', 'local.db'),
          path.join(os.homedir(), '.qoder', 'shared_client', 'cache', 'db', 'local.db'),
        ]
      : [
          resolveHome('~/.config/Qoder/SharedClientCache/cache/db/local.db'),
          resolveHome('~/.qoder/shared_client/cache/db/local.db'),
        ];

  // Sync access check: only runs once per collect cycle for a fixed set of paths.
  // Acceptable because the path list is small (1-2 candidates) and the result is cached by callers.
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

function parseModelKey(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const obj = JSON.parse(raw);
    return typeof obj.model_key === 'string' && obj.model_key.length > 0
      ? obj.model_key
      : undefined;
  } catch {
    return undefined;
  }
}

function parseRecordModelKey(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const obj = JSON.parse(raw);
    const key = obj?.modelConfig?.key;
    return typeof key === 'string' && key.length > 0 ? key : undefined;
  } catch {
    return undefined;
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
