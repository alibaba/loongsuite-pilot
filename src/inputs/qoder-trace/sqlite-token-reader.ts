import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mimeFromMediaPath } from '../../multimodal/resolve.js';
import { resolveHome } from '../../utils/fs-utils.js';
import { queryReadonly, queryReadonlyPaged } from '../../utils/node-sqlite.js';
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
  contextWindow?: number;
}

export interface SqliteRequestModel {
  requestId: string;
  messageId: string;
  gmtCreate: number;
  model: string;
}

export interface SqliteTokenResult {
  rows: SqliteTokenData[];
  requestModels?: SqliteRequestModel[];
  /** The DB path that contained the session data, for caller-side variant detection. */
  matchedDbPath: string | null;
}

export interface AttachedImageLookup {
  paths: string[];
  /** Earliest user chat_message.gmt_create (unix ms). */
  startMs?: number;
}

/**
 * Batch-read attached image paths, plus file identifiers, from chat_record.extra.
 * Keys are request_id. Also returns the user-message start clock when present.
 * DB paths are resolved the same way as token enrichment (not caller-supplied).
 * Fail-open: query errors are logged and skipped.
 * Only request_ids that appear in a row are recorded (`paths: []` if extra has no media).
 */
export async function readAttachedImagePathsForRequestIds(
  requestIds: string[],
): Promise<Map<string, AttachedImageLookup>> {
  const result = new Map<string, AttachedImageLookup>();
  const unique = [...new Set(requestIds.map(id => id.trim()).filter(Boolean))];
  if (unique.length === 0) return result;

  const dbPaths = resolveAllQoderDbPaths();
  if (dbPaths.length === 0) return result;

  const placeholders = unique.map(() => '?').join(', ');
  const sql = `
    SELECT
      cr.request_id AS request_id,
      cr.extra AS extra,
      (
        SELECT MIN(cm.gmt_create)
        FROM chat_message cm
        WHERE cm.request_id = cr.request_id
          AND cm.role = 'user'
      ) AS user_gmt_create
    FROM chat_record cr
    WHERE cr.request_id IN (${placeholders})
  `;

  for (const dbPath of dbPaths) {
    let rows: Array<{
      request_id: string;
      extra: string | null;
      user_gmt_create?: number | string | null;
    }>;
    try {
      rows = await queryReadonly(dbPath, sql, unique);
    } catch (err) {
      logger.debug('sqlite attachedImagePaths query failed', { dbPath, error: String(err) });
      continue;
    }
    for (const row of rows) {
      const requestId = row.request_id?.trim();
      if (!requestId || result.has(requestId)) continue;
      const lookup: AttachedImageLookup = { paths: parseAttachedImagePaths(row.extra) };
      const startMs = parseGmtCreateMs(row.user_gmt_create);
      if (startMs !== undefined) lookup.startMs = startMs;
      result.set(requestId, lookup);
    }
    if (result.size >= unique.length) break;
  }
  return result;
}

function parseGmtCreateMs(raw: number | string | null | undefined): number | undefined {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function parseAttachedImagePaths(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const extra = JSON.parse(raw) as Record<string, unknown>;
    const paths: string[] = [];

    if (Array.isArray(extra.attachedImagePaths)) {
      for (const item of extra.attachedImagePaths) {
        if (typeof item === 'string' && item.trim()) paths.push(item.trim());
      }
    }
    const hasAttachedImages = paths.length > 0;

    const context = Array.isArray(extra.context) ? extra.context : [];
    for (const item of context) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      if (record.name === 'file') {
        const selected = record.selectedItem;
        if (selected && typeof selected === 'object') {
          const identifier = (selected as Record<string, unknown>).identifier;
          if (typeof identifier === 'string') {
            const trimmed = identifier.trim();
            if (trimmed && mimeFromMediaPath(trimmed)) paths.push(trimmed);
          }
        }
      }
      if (hasAttachedImages) continue;
      const fileType = typeof record.fileType === 'string' ? record.fileType : '';
      if (record.name !== 'image' && fileType !== 'image') continue;
      const imgUrl = typeof record.imgUrl === 'string' ? record.imgUrl.trim() : '';
      const filePath = typeof record.filePath === 'string' ? record.filePath.trim() : '';
      const candidate = imgUrl || filePath;
      if (candidate) paths.push(candidate);
    }
    return [...new Set(paths)];
  } catch {
    return [];
  }
}

export async function readSqliteTokensForSession(sessionId: string): Promise<SqliteTokenResult> {
  return readSqliteTokensFromCandidates(sessionId, resolveAllQoderDbPaths(), isIdeaDbPath);
}

/** Read each product's own candidates without mixing usage and model rows across DBs. */
export async function readSqliteTokensFromCandidates(
  sessionId: string,
  dbPaths: readonly string[],
  withRequestModels: (dbPath: string) => boolean,
): Promise<SqliteTokenResult> {
  let modelOnly: SqliteTokenResult | undefined;
  for (const dbPath of dbPaths) {
    let rows: SqliteTokenRow[];
    try {
      rows = withRequestModels(dbPath)
        ? await readSqliteTokenRows(dbPath, sessionId, true).catch(error => {
          // Older clients may omit chat_record or its model metadata.
          logger.debug('sqlite request-model query failed', { sessionId, dbPath, error: String(error) });
          return readSqliteTokenRows(dbPath, sessionId, false);
        })
        : await readSqliteTokenRows(dbPath, sessionId, false);
    } catch (err) {
      logger.debug('sqlite query failed', { sessionId, dbPath, error: String(err) });
      continue;
    }

    if (rows.length === 0) continue;

    const results: SqliteTokenData[] = [];
    const requestModels: SqliteRequestModel[] = [];
    for (const row of rows) {
      if (row.request_id && row.request_model) {
        requestModels.push({
          requestId: row.request_id,
          messageId: row.message_id ?? '',
          gmtCreate: row.gmt_create,
          model: row.request_model,
        });
      }
      const info = row.token_info ? parseTokenInfo(row.token_info) : null;
      if (!info) continue;
      results.push({
        sessionId: row.session_id ?? '',
        requestId: row.request_id ?? '',
        messageId: row.message_id ?? '',
        gmtCreate: row.gmt_create,
        inputTokens: info.promptTokens,
        outputTokens: info.completionTokens,
        cacheReadTokens: info.cachedTokens,
        contextWindow: info.contextWindow,
        model: parseModelKey(row.model_info),
      });
    }
    if (results.length > 0) return { rows: results, requestModels, matchedDbPath: dbPath };
    if (requestModels.length > 0) modelOnly ??= { rows: [], requestModels, matchedDbPath: dbPath };
  }
  return modelOnly ?? { rows: [], matchedDbPath: null };
}

interface SqliteTokenRow {
  message_id?: string;
  session_id?: string;
  request_id: string;
  gmt_create: number;
  token_info: string | null;
  model_info?: string | null;
  request_model: string | null;
}

function readSqliteTokenRows(dbPath: string, sessionId: string, withRequestModels: boolean): Promise<SqliteTokenRow[]> {
  // Group repeated records before joining. They must not duplicate usage
  // rows or turn conflicting model selections into an arbitrary choice.
  const modelQuery = `
    WITH recorded_models AS (
      SELECT request_id, CASE WHEN json_valid(extra) THEN
        CASE WHEN json_type(extra, '$.modelConfig.key') = 'text'
          THEN trim(json_extract(extra, '$.modelConfig.key')) END
      END AS model
      FROM chat_record
      WHERE session_id = ?
    ), request_models AS (
      SELECT request_id, MIN(model) AS request_model
      FROM recorded_models
      WHERE length(model) BETWEEN 1 AND 512 AND lower(model) NOT IN ('unknown', 'custom_model')
      GROUP BY request_id
      HAVING COUNT(DISTINCT model) = 1
    )
  `;
  const sql = `
    ${withRequestModels ? modelQuery : ''}
    SELECT
      cm.id AS message_id,
      cm.session_id AS session_id,
      cm.request_id AS request_id,
      cm.gmt_create AS gmt_create,
      cm.token_info AS token_info,
      cm.model_info AS model_info,
      ${withRequestModels ? 'rm.request_model' : 'NULL'} AS request_model
    FROM chat_message cm
    ${withRequestModels ? 'LEFT JOIN request_models rm ON rm.request_id = cm.request_id' : ''}
    WHERE cm.session_id = ?
      AND cm.role = 'assistant'
      AND (json_valid(cm.token_info)${withRequestModels ? ' OR rm.request_model IS NOT NULL' : ''})
      AND (? = 0 OR cm.gmt_create > ? OR (cm.gmt_create = ? AND cm.id > ?))
    ORDER BY cm.gmt_create ASC, cm.id ASC
  `;

  const sessionParams = withRequestModels ? [sessionId, sessionId] : [sessionId];
  return queryReadonlyPaged(dbPath, sql, (cursor) => [
    ...sessionParams, cursor.continued, cursor.sort, cursor.sort, cursor.id,
  ], (row) => ({ sort: row.gmt_create, id: row.message_id ?? '' }));
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

/** Desktop Qoder data root (macOS Application Support / Windows AppData / Linux XDG). */
export function resolveQoderAppRoot(): string {
  if (process.platform === 'darwin') {
    return resolveHome('~/Library/Application Support/Qoder');
  }
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appdata, 'Qoder');
  }
  return resolveHome('~/.config/Qoder');
}

/** Desktop app-support DB, hashed-profile DBs, and JetBrains ~/.qoder/shared_client. */
export function resolveAllQoderDbPaths(): string[] {
  const qoderRoot = resolveQoderAppRoot();

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

export function parseTokenInfo(raw: string): { promptTokens: number; completionTokens: number; cachedTokens: number; contextWindow?: number } | null {
  try {
    const obj = JSON.parse(raw);
    const pt = typeof obj.prompt_tokens === 'number' ? obj.prompt_tokens : 0;
    const ct = typeof obj.completion_tokens === 'number' ? obj.completion_tokens : 0;
    const cached = typeof obj.cached_tokens === 'number' ? obj.cached_tokens : 0;
    if (pt === 0 && ct === 0) return null;
    return { promptTokens: pt, completionTokens: ct, cachedTokens: cached,
      ...(Number.isFinite(obj.max_input_tokens) && obj.max_input_tokens > 0 ? { contextWindow: obj.max_input_tokens } : {}) };
  } catch {
    return null;
  }
}

export function parseModelKey(raw: string | null | undefined): string | undefined {
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

export function parseRecordModelKey(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const obj = JSON.parse(raw);
    const key = obj?.modelConfig?.key;
    return typeof key === 'string' && key.length > 0 ? key : undefined;
  } catch {
    return undefined;
  }
}

