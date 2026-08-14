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

export interface SqliteTokenResult {
  rows: SqliteTokenData[];
  /** The DB path that contained the session data, for caller-side variant detection. */
  matchedDbPath: string | null;
}

/**
 * Batch-read user-attached image paths from chat_record.extra.
 * Keys are request_id; values are local image paths for that request.
 * DB paths are resolved the same way as token enrichment (not caller-supplied).
 * Fail-open: query errors are logged and skipped.
 */
export async function readAttachedImagePathsForRequestIds(
  requestIds: string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  const unique = [...new Set(requestIds.map(id => id.trim()).filter(Boolean))];
  if (unique.length === 0) return result;

  const dbPaths = resolveAllQoderDbPaths();
  if (dbPaths.length === 0) return result;

  const placeholders = unique.map(() => '?').join(', ');
  const sql = `
    SELECT request_id AS request_id, extra AS extra
    FROM chat_record
    WHERE request_id IN (${placeholders})
  `;

  for (const dbPath of dbPaths) {
    let rows: Array<{ request_id: string; extra: string | null }>;
    try {
      rows = await queryReadonly(dbPath, sql, unique);
    } catch (err) {
      logger.debug('sqlite attachedImagePaths query failed', { dbPath, error: String(err) });
      continue;
    }
    for (const row of rows) {
      const requestId = row.request_id?.trim();
      if (!requestId || result.has(requestId)) continue;
      const paths = parseAttachedImagePaths(row.extra);
      if (paths.length > 0) result.set(requestId, paths);
    }
    if (result.size >= unique.length) break;
  }
  return result;
}

function parseAttachedImagePaths(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const extra = JSON.parse(raw) as Record<string, unknown>;

    const fromField: string[] = [];
    if (Array.isArray(extra.attachedImagePaths)) {
      for (const item of extra.attachedImagePaths) {
        if (typeof item === 'string' && item.trim()) fromField.push(item.trim());
      }
    }
    if (fromField.length > 0) return [...new Set(fromField)];

    // Fallback: context entries marked as image.
    const fromContext: string[] = [];
    const context = Array.isArray(extra.context) ? extra.context : [];
    for (const item of context) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const name = typeof record.name === 'string' ? record.name : '';
      const fileType = typeof record.fileType === 'string' ? record.fileType : '';
      if (name !== 'image' && fileType !== 'image') continue;
      const imgUrl = typeof record.imgUrl === 'string' ? record.imgUrl.trim() : '';
      const filePath = typeof record.filePath === 'string' ? record.filePath.trim() : '';
      const candidate = imgUrl || filePath;
      if (candidate) fromContext.push(candidate);
    }
    return [...new Set(fromContext)];
  } catch {
    return [];
  }
}

export async function readSqliteTokensForSession(sessionId: string): Promise<SqliteTokenResult> {
  const dbPaths = resolveAllQoderDbPaths();
  if (dbPaths.length === 0) return { rows: [], matchedDbPath: null };

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
 * Determine if a matched DB path belongs to the IntelliJ-specific database.
 * Normalizes path separators to handle Windows backslashes correctly.
 */
export function isIdeaDbPath(dbPath: string | null): boolean {
  if (!dbPath) return false;
  const normalized = dbPath.replace(/\\/g, '/');
  return normalized.includes('.qoder/shared_client');
}

/** Relative path from a Qoder profile root to local.db. */
const QODER_DB_TAIL = path.join('SharedClientCache', 'cache', 'db', 'local.db');

/** Desktop app-support DB, hashed-profile DBs, and JetBrains ~/.qoder/shared_client. */
export function resolveAllQoderDbPaths(): string[] {
  const appdata = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  const qoderRoot = process.platform === 'darwin'
    ? resolveHome('~/Library/Application Support/Qoder')
    : process.platform === 'win32'
      ? path.join(appdata, 'Qoder')
      : resolveHome('~/.config/Qoder');

  const candidates = [
    path.join(qoderRoot, QODER_DB_TAIL),
    ...listHashedProfileDbPaths(qoderRoot),
    resolveHome('~/.qoder/shared_client/cache/db/local.db'),
  ];

  const available: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      fs.accessSync(candidate);
      available.push(candidate);
    } catch {
      continue;
    }
  }
  return available;
}

/** Linux remote / multi-profile Qoder nests local.db under <qoderRoot>/<hash>/. */
function listHashedProfileDbPaths(qoderRoot: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(qoderRoot);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const name of names) {
    if (name === 'SharedClientCache') continue;
    found.push(path.join(qoderRoot, name, QODER_DB_TAIL));
  }
  return found;
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
