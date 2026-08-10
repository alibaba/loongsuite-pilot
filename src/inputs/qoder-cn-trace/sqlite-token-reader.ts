import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import sqlite3 from 'sqlite3';
import { resolveHome } from '../../utils/fs-utils.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('QoderCnSqliteTokenReader');

/** Path tail shared by the standalone-app layouts, appended to an app-support dir name. */
const DB_PATH_SEGMENTS = ['SharedClientCache', 'cache', 'db', 'local.db'] as const;

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

export interface SqliteTokenResult {
  rows: SqliteTokenData[];
  /** The candidate DB that contained this session. Debug logging only — see resolveQoderCnDbPaths. */
  matchedDbPath: string | null;
}

export async function readSqliteTokensForSession(sessionId: string): Promise<SqliteTokenResult> {
  const dbPaths = resolveQoderCnDbPaths();
  if (dbPaths.length === 0) return { rows: [], matchedDbPath: null };

  const sql = `
    SELECT
      cm.id            AS message_id,
      cm.session_id    AS session_id,
      cm.request_id    AS request_id,
      cm.gmt_create    AS gmt_create,
      cm.token_info    AS token_info,
      cm.model_info    AS model_info,
      cr.extra         AS record_extra
    FROM chat_message cm
    LEFT JOIN chat_record cr ON cr.request_id = cm.request_id
    WHERE cm.session_id = ?
      AND cm.role = 'assistant'
      AND cm.token_info IS NOT NULL
      AND cm.token_info != ''
      AND json_valid(cm.token_info)
    ORDER BY cm.gmt_create ASC
  `;

  for (const dbPath of dbPaths) {
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
      logger.debug('sqlite query failed', { sessionId, dbPath, error: String(err) });
      continue;
    }

    if (rows.length === 0) continue;

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
    if (results.length > 0) return { rows: results, matchedDbPath: dbPath };
  }

  return { rows: [], matchedDbPath: null };
}

/**
 * Qoder CN ships more than one data layout, and both share the same `~/.qoder-cn`
 * config directory:
 *
 *   IDE plugin host  ~/.qoder-cn/shared_client/cache/db/local.db
 *   standalone app   <app-support>/QoderCN/SharedClientCache/cache/db/local.db
 *
 * Config-dir presence therefore says nothing about where the DB lives, so probe every
 * accessible candidate and let `session_id` decide ownership: a candidate that does not
 * contain the session simply returns zero rows and we move on. Session ids are per-session
 * UUIDs, so a wrong candidate can never mis-attribute data.
 *
 * `<app-support>/Qoder/SharedClientCache/...` is deliberately NOT a candidate: that is the
 * international Qoder desktop DB. No CN build has been observed using it, and it can be
 * hundreds of MB — opening it on every enrichment would cost real IO for no benefit.
 *
 * DO NOT use the matched path to derive or rewrite `gen_ai.agent.type`. Identity comes only
 * from hook deploy location -> hook script agent id -> the hook record. `qoder-trace` does
 * relabel qoder -> qoder-idea via `isIdeaDbPath()`, which tests
 * `includes('.qoder/shared_client')`; `.qoder-cn/shared_client` escapes that test purely
 * because the substring is `-cn/` rather than `/`. That is a coincidence, not a guarantee.
 * Copying that pattern here, or loosening the test, would mislabel every Qoder CN user.
 */
function resolveQoderCnDbPaths(): string[] {
  const appSupportRoot = process.platform === 'darwin'
    ? resolveHome('~/Library/Application Support')
    : process.platform === 'win32'
      ? (process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'))
      : resolveHome('~/.config');

  // Ordered by observed hit rate.
  const candidates = [
    path.join(os.homedir(), '.qoder-cn', 'shared_client', 'cache', 'db', 'local.db'),
    path.join(appSupportRoot, 'QoderCN', ...DB_PATH_SEGMENTS),
    path.join(appSupportRoot, 'Qoder CN', ...DB_PATH_SEGMENTS),
  ];

  const available: string[] = [];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate);
      available.push(candidate);
    } catch {
      continue;
    }
  }
  return available;
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
