import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import sqlite3 from 'sqlite3';
import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry, JsonValue } from '../../types/index.js';
import { buildAgentActivityEntry } from '../../normalization/entry-builder.js';
import { resolveHome } from '../../utils/fs-utils.js';
import {
  BaseSqliteInput,
  type SqliteInputOptions,
  type SqliteRow,
} from '../base/base-sqlite-input.js';

const DEFAULT_QODER_CN_ROOT_MAC = '~/Library/Application Support/QoderCN';
const DEFAULT_QODER_CN_ROOT_LINUX = '~/.config/QoderCN';
const QODER_CN_DB_RELATIVE_PATH = path.join('SharedClientCache', 'cache', 'db', 'local.db');
const SOURCE = 'qoder-cn-sqlite-chat-message';
const UNKNOWN_MODEL = 'unknown';

export interface QoderCnSqliteInputOptions extends Omit<SqliteInputOptions, 'dbPath'> {
  dbPath?: string;
  dataRoot?: string;
}

interface QoderCnTokenRow extends SqliteRow {
  id: string;
  sessionId: string | null;
  requestId: string | null;
  role: string | null;
  tokenInfo: string;
  gmtCreate: number;
}

interface QoderCnTokenInfo {
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  max_input_tokens?: number;
}

/**
 * QoderCN SQLite — token usage from SharedClientCache/cache/db/local.db.
 */
export class QoderCnSqliteInput extends BaseSqliteInput {
  readonly id = 'qoder-cn-sqlite';
  readonly agentType = ClientType.QoderCn;

  constructor(opts: QoderCnSqliteInputOptions) {
    const dataRoot = opts.dataRoot ?? resolveQoderCnRoot();
    super({
      stateStore: opts.stateStore,
      dbPath: opts.dbPath ?? resolveQoderCnDbPath(dataRoot),
      pollIntervalMs: opts.pollIntervalMs
        ?? (Number(process.env.QODER_CN_ANALYTICS_POLL_INTERVAL) || 30_000),
    });
  }

  static getWatchPaths(): string[] {
    return [path.dirname(resolveQoderCnDbPath(resolveQoderCnRoot()))];
  }

  static async checkAvailability(): Promise<boolean> {
    try {
      await fs.access(resolveQoderCnDbPath(resolveQoderCnRoot()));
      return true;
    } catch {
      return false;
    }
  }

  protected override async onStart(): Promise<void> {
    if (this.stateStore.get(this.id).lastRowId !== undefined) return;

    try {
      const maxRowId = await readMaxEligibleRowId(this.dbPath);
      this.stateStore.setRowId(this.id, maxRowId);
    } catch (err) {
      this.logger.warn('failed to baseline QoderCN SQLite cursor', { error: String(err) });
    }
  }

  protected async readNewRows(lastRowId: number): Promise<SqliteRow[]> {
    const sql = `
      SELECT
        rowid,
        id,
        session_id AS sessionId,
        request_id AS requestId,
        role,
        token_info AS tokenInfo,
        gmt_create AS gmtCreate
      FROM chat_message
      WHERE rowid > ?
        AND token_info IS NOT NULL
        AND token_info != ''
        AND json_valid(token_info)
      ORDER BY rowid ASC
    `;

    return queryReadonly<QoderCnTokenRow>(this.dbPath, sql, [lastRowId]);
  }

  protected async transformRow(row: SqliteRow): Promise<AgentActivityEntry | null> {
    const qoderCnRow = row as QoderCnTokenRow;
    const tokenInfo = parseTokenInfo(qoderCnRow.tokenInfo);
    if (!tokenInfo) return null;

    const inputTokens = finiteNumber(tokenInfo.prompt_tokens);
    const outputTokens = finiteNumber(tokenInfo.completion_tokens);
    const cacheReadTokens = finiteNumber(tokenInfo.cached_tokens);
    const maxInputTokens = finiteNumber(tokenInfo.max_input_tokens);

    const attributes: Record<string, JsonValue> = {
      source: SOURCE,
      rowid: qoderCnRow.rowid,
      message_id: qoderCnRow.id,
    };
    if (qoderCnRow.requestId) attributes.request_id = qoderCnRow.requestId;
    if (maxInputTokens !== undefined) attributes.max_input_tokens = maxInputTokens;

    return buildAgentActivityEntry({
      timestamp: qoderCnRow.gmtCreate,
      'event.id': qoderCnRow.id || undefined,
      'event.name': 'llm.response',
      'gen_ai.session.id': qoderCnRow.sessionId ?? '',
      'gen_ai.agent.type': ClientType.QoderCn,
      'gen_ai.request.model': UNKNOWN_MODEL,
      'gen_ai.response.model': UNKNOWN_MODEL,
      'gen_ai.usage.input_tokens': inputTokens,
      'gen_ai.usage.output_tokens': outputTokens,
      'gen_ai.usage.cache_read.input_tokens': cacheReadTokens,
      'gen_ai.usage.total_tokens': sumIfPresent(inputTokens, outputTokens),
      attributes,
    });
  }
}

function resolveQoderCnRoot(): string {
  if (process.platform === 'darwin') {
    return resolveHome(DEFAULT_QODER_CN_ROOT_MAC);
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'QoderCN');
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, 'QoderCN');
  return resolveHome(DEFAULT_QODER_CN_ROOT_LINUX);
}

function resolveQoderCnDbPath(dataRoot: string): string {
  return path.join(dataRoot, QODER_CN_DB_RELATIVE_PATH);
}

function readMaxEligibleRowId(dbPath: string): Promise<number> {
  const sql = `
    SELECT COALESCE(MAX(rowid), 0) AS maxRowId
    FROM chat_message
    WHERE token_info IS NOT NULL
      AND token_info != ''
      AND json_valid(token_info)
  `;
  return queryReadonly<{ maxRowId: number }>(dbPath, sql, [])
    .then(rows => rows[0]?.maxRowId ?? 0);
}

function queryReadonly<T>(
  dbPath: string,
  sql: string,
  params: unknown[],
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    let db: sqlite3.Database;
    db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (openErr) => {
      if (openErr) {
        reject(openErr);
        return;
      }

      db.all(sql, params, (queryErr: Error | null, rows: T[]) => {
        db.close((closeErr) => {
          if (queryErr) {
            reject(queryErr);
            return;
          }
          if (closeErr) {
            reject(closeErr);
            return;
          }
          resolve(rows);
        });
      });
    });
  });
}

function parseTokenInfo(raw: string): QoderCnTokenInfo | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as QoderCnTokenInfo;
  } catch {
    return null;
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sumIfPresent(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined || right === undefined) return undefined;
  return left + right;
}
