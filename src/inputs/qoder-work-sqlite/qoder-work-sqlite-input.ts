import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import sqlite3 from 'sqlite3';
import { ClientType, CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry, JsonValue } from '../../types/index.js';
import { buildAgentActivityEntry } from '../../normalization/entry-builder.js';
import { BaseInput, type InputOptions } from '../base/base-input.js';
import { resolveQoderWorkRoot } from '../qoder-work-log/qoder-work-log-input.js';
/** Relative path of the SQLite DB inside the QoderWork data root. */
const DB_REL_PATH = path.join('data', 'agents.db');
const SOURCE = 'qoder-work-sqlite';
const UNKNOWN_MODEL = 'unknown';
const SQL_BATCH_LIMIT = 1000;

export interface QoderWorkSqliteInputOptions extends InputOptions {
  dbPath?: string;
  dataRoot?: string;
  agentType?: ClientType;
}

/**
 * One row of the `messages` table joined with `sub_chats.session_id`.
 * Note: QoderWork stores `updated_at` as a unix timestamp in SECONDS.
 */
interface MessageRow {
  id: string;
  sessionId: string | null;
  subChatId: string;
  sequence: number;
  role: string;
  parts: string;
  updatedAt: number;
  /**
   * `sub_chats.model_level` — QoderWork stores the actual LLM model name
   * (e.g. `qwork-ultimate` / `qwork-auto`) here. May be null if the parent
   * sub_chat is missing or the column was not populated for older rows.
   */
  modelLevel: string | null;
}

/**
 * Qoder Work — SQLite agents.db input.
 *
 * Polls QoderWork's `messages` table (joined with `sub_chats` to recover the
 * agent session id) by `updated_at` cursor. Modern QoderWork builds keep the
 * `sub_chats.messages` column at `'[]'` and persist real chat content into
 * the dedicated `messages` table; reading there is the only way to obtain
 * user prompts and tool results.
 *
 * Emits:
 *   - one `llm.request` per `messages` row with role='user' (text parts).
 *   - one `tool.result` per assistant `tool-*` part (excluding `tool-Thinking`).
 *
 * Idempotency is enforced via deterministic event.id (sha256 over key fields),
 * so repeated reads of the same row produce the same entries.
 */
export class QoderWorkSqliteInput extends BaseInput {
  readonly id: string;
  readonly agentType: ClientType;
  readonly collectionMethod = CollectionMethod.SqlitePolling;

  protected readonly dbPath: string;

  constructor(opts: QoderWorkSqliteInputOptions) {
    super(opts);
    const agentType = opts.agentType ?? ClientType.QoderWork;
    const dataRoot = opts.dataRoot ?? resolveQoderWorkRoot(agentType === ClientType.QoderWorkCN ? 'cn' : 'standard');
    this.agentType = agentType;
    this.id = `${agentType}-sqlite`;
    this.dbPath = opts.dbPath ?? path.join(dataRoot, DB_REL_PATH);
    this.pollIntervalMs = opts.pollIntervalMs ?? 30_000;
  }

  static getWatchPaths(): string[] {
    return [path.dirname(path.join(resolveQoderWorkRoot(), DB_REL_PATH))];
  }

  static async checkAvailability(): Promise<boolean> {
    try {
      await fs.access(path.join(resolveQoderWorkRoot(), DB_REL_PATH));
      return true;
    } catch {
      return false;
    }
  }

  protected override async onStart(): Promise<void> {
    const state = this.stateStore.get(this.id);
    if (state.extra && typeof state.extra.lastUpdatedAt === 'number') return;

    try {
      const baseline = await readMaxUpdatedAt(this.dbPath);
      this.stateStore.update(this.id, {
        extra: { lastUpdatedAt: baseline },
      });
    } catch (err) {
      this.logger.warn('failed to baseline qoder-work sqlite cursor', { error: String(err) });
    }
  }

  protected async collect(): Promise<AgentActivityEntry[]> {
    const state = this.stateStore.get(this.id);
    const cursor = (state.extra && typeof state.extra.lastUpdatedAt === 'number')
      ? state.extra.lastUpdatedAt as number
      : 0;

    let rows: MessageRow[];
    try {
      rows = await readNewMessageRows(this.dbPath, cursor);
    } catch (err) {
      this.logger.error('failed to read qoder-work sqlite rows', { error: String(err) });
      return [];
    }
    if (rows.length === 0) return [];

    const entries: AgentActivityEntry[] = [];
    let maxUpdate = cursor;

    for (const row of rows) {
      if (row.updatedAt > maxUpdate) maxUpdate = row.updatedAt;
      try {
        const rowEntries = transformRow(row, this.agentType);
        entries.push(...rowEntries);
      } catch (err) {
        this.logger.warn('row transform failed', {
          messageId: row.id,
          error: String(err),
        });
      }
    }

    this.stateStore.update(this.id, {
      extra: { lastUpdatedAt: maxUpdate },
    });
    return entries;
  }
}

function transformRow(row: MessageRow, agentType: ClientType): AgentActivityEntry[] {
  const sessionId = row.sessionId ?? '';
  // QoderWork stores `updated_at` as unix seconds; normalise to milliseconds
  // so downstream timestamp serialisation matches the rest of the pipeline.
  const tsMs = row.updatedAt > 0 ? row.updatedAt * 1000 : Date.now();
  const model = row.modelLevel && row.modelLevel.length > 0
    ? row.modelLevel
    : UNKNOWN_MODEL;

  let parts: unknown;
  try {
    parts = JSON.parse(row.parts);
  } catch {
    return [];
  }
  if (!Array.isArray(parts)) return [];

  const out: AgentActivityEntry[] = [];

  if (row.role === 'user') {
    const content = extractUserText(parts as unknown[]);
    if (!content) return out;
    out.push(
      buildAgentActivityEntry({
        timestamp: tsMs,
        'event.id': hashId([sessionId, row.id, 'user']),
        'event.name': 'llm.request',
        'gen_ai.session.id': sessionId,
        'gen_ai.agent.type': agentType,
        'gen_ai.request.model': model,
        'gen_ai.input.messages_delta': [
          { role: 'user', content },
        ],
        attributes: {
          source: SOURCE,
          event_kind: 'user_prompt',
          message_id: row.id,
          sub_chat_id: row.subChatId,
          sequence: row.sequence,
        },
      }),
    );
    return out;
  }

  if (row.role !== 'assistant') return out;

  for (let i = 0; i < parts.length; i++) {
    const partRaw = (parts as unknown[])[i];
    if (!partRaw || typeof partRaw !== 'object') continue;
    const part = partRaw as Record<string, unknown>;
    const partType = stringOr(part.type, '');
    if (!partType.startsWith('tool-') || partType === 'tool-Thinking') continue;

    const callId = stringOr(part.toolCallId, '') || stringOr(part.tool_call_id, '');
    const toolName = stringOr(part.toolName, '')
      || stringOr(part.tool_name, '')
      || stringOr(part.name, '')
      || partType.replace(/^tool-/, '');

    const rawResult = part.output ?? part.result;
    if (!callId || rawResult === undefined) continue;

    const resultPayload: JsonValue = typeof rawResult === 'string'
      ? rawResult
      : toJsonValue(rawResult) ?? '';

    out.push(
      buildAgentActivityEntry({
        timestamp: tsMs,
        'event.id': hashId([sessionId, row.id, 'tool_result', callId, String(i)]),
        'event.name': 'tool.result',
        'gen_ai.session.id': sessionId,
        'gen_ai.agent.type': agentType,
        'gen_ai.request.model': model,
        'gen_ai.tool.name': toolName,
        'gen_ai.tool.call.id': callId,
        'gen_ai.tool.call.exec.id': callId,
        'gen_ai.tool.call.result': resultPayload,
        'tool.result.status': 'success',
        attributes: {
          source: SOURCE,
          event_kind: 'tool_result',
          message_id: row.id,
          sub_chat_id: row.subChatId,
          part_type: partType,
        },
      }),
    );
  }

  return out;
}

function extractUserText(parts: unknown[]): string {
  const texts: string[] = [];
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue;
    const part = p as Record<string, unknown>;
    if (stringOr(part.type, '') !== 'text') continue;
    const t = stringOr(part.text, '') || stringOr(part.content, '');
    if (t) texts.push(t);
  }
  return texts.join('\n');
}

function readNewMessageRows(dbPath: string, cursor: number): Promise<MessageRow[]> {
  // LEFT JOIN keeps rows even if their parent sub_chat is missing; session_id
  // becomes null in that case but the message itself is still observable.
  const sql = `
    SELECT
      m.id           AS id,
      sc.session_id  AS sessionId,
      m.sub_chat_id  AS subChatId,
      m.sequence     AS sequence,
      m.role         AS role,
      m.parts        AS parts,
      m.updated_at   AS updatedAt,
      sc.model_level AS modelLevel
    FROM messages m
    LEFT JOIN sub_chats sc ON sc.id = m.sub_chat_id
    WHERE m.updated_at > ?
      AND m.parts IS NOT NULL
      AND m.parts != ''
      AND m.parts != '[]'
    ORDER BY m.updated_at ASC, m.sequence ASC
    LIMIT ${SQL_BATCH_LIMIT}
  `;
  return queryReadonly<MessageRow>(dbPath, sql, [cursor]);
}

function readMaxUpdatedAt(dbPath: string): Promise<number> {
  const sql = `SELECT COALESCE(MAX(updated_at), 0) AS maxUpdate FROM messages`;
  return queryReadonly<{ maxUpdate: number }>(dbPath, sql, []).then(
    rows => rows[0]?.maxUpdate ?? 0,
  );
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


function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function hashId(parts: Array<string | number | undefined>): string {
  return crypto
    .createHash('sha256')
    .update(parts.map(p => p ?? '').join('\0'))
    .digest('hex');
}

function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    const arr: JsonValue[] = [];
    for (const item of value) {
      const v = toJsonValue(item);
      if (v !== undefined) arr.push(v);
    }
    return arr;
  }
  if (typeof value === 'object') {
    const obj: { [key: string]: JsonValue } = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const json = toJsonValue(v);
      if (json !== undefined) obj[k] = json;
    }
    return obj;
  }
  return String(value);
}
