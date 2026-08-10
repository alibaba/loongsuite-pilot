import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import sqlite3 from 'sqlite3';
import { BaseInput, type InputOptions } from '../base/base-input.js';
import { buildAgentActivityEntry } from '../../normalization/entry-builder.js';
import { ClientType, CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry, JsonValue } from '../../types/index.js';

const DB_REL_PATH = path.join('data', 'agents.db');
const SOURCE = 'qwen-work-cn-sqlite';
const SQL_BATCH_LIMIT = 1000;
const TOOL_RESULT_DEDUPE_LIMIT = 50_000;

export interface QwenWorkCNSqliteInputOptions extends InputOptions {
  dbPath?: string;
  dataRoot?: string;
}

interface MessageRow {
  rowId: number;
  id: string;
  sessionId: string | null;
  subChatId: string;
  sequence: number;
  role: string;
  parts: string;
  updatedAt: number;
  modelLevel: string | null;
}

export function resolveQwenWorkCNRoot(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'QwenWorkCN');
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'QwenWorkCN');
}

/** Independent SQLite collector for QwenWorkCN's agents.db. */
export class QwenWorkCNSqliteInput extends BaseInput {
  readonly id = 'qwen-work-cn-sqlite';
  readonly agentType = ClientType.QwenWorkCN;
  readonly collectionMethod = CollectionMethod.SqlitePolling;
  protected readonly dbPath: string;

  constructor(opts: QwenWorkCNSqliteInputOptions) {
    super(opts);
    this.dbPath = opts.dbPath ?? path.join(opts.dataRoot ?? resolveQwenWorkCNRoot(), DB_REL_PATH);
    this.pollIntervalMs = opts.pollIntervalMs ?? 30_000;
  }

  static getWatchPaths(): string[] {
    return [path.join(resolveQwenWorkCNRoot(), 'data')];
  }

  static async checkAvailability(): Promise<boolean> {
    try {
      await fs.access(path.join(resolveQwenWorkCNRoot(), DB_REL_PATH));
      return true;
    } catch {
      return false;
    }
  }

  protected override async onStart(): Promise<void> {
    const state = this.stateStore.get(this.id);
    if (typeof state.extra?.lastUpdatedAt === 'number') {
      if (typeof state.extra?.lastUpdatedRowId !== 'number') {
        // Replay the legacy cursor's boundary second once so rows previously
        // skipped by the timestamp-only cursor can be recovered.
        this.stateStore.update(this.id, {
          extra: { ...plainObject(state.extra), lastUpdatedRowId: 0 },
        });
      }
      return;
    }
    try {
      const cursor = await readLatestCursor(this.dbPath);
      this.stateStore.update(this.id, {
        extra: {
          ...plainObject(state.extra),
          lastUpdatedAt: cursor.updatedAt,
          lastUpdatedRowId: cursor.rowId,
        },
      });
    } catch (error) {
      this.logger.warn('failed to baseline qwen-work-cn sqlite cursor', { error: String(error) });
    }
  }

  protected async collect(): Promise<AgentActivityEntry[]> {
    const state = this.stateStore.get(this.id);
    const cursorUpdatedAt = typeof state.extra?.lastUpdatedAt === 'number' ? state.extra.lastUpdatedAt : 0;
    const cursorRowId = typeof state.extra?.lastUpdatedRowId === 'number'
      ? state.extra.lastUpdatedRowId
      : 0;
    let rows: MessageRow[];
    try {
      rows = await readRows(this.dbPath, cursorUpdatedAt, cursorRowId);
    } catch (error) {
      this.logger.error('failed to read qwen-work-cn sqlite rows', { error: String(error) });
      return [];
    }
    if (!rows.length) return [];

    const emittedIds = new Set(stringArray(state.extra, 'emittedToolResultIds'));
    const entries: AgentActivityEntry[] = [];
    for (const row of rows) {
      entries.push(...mapRow(row, emittedIds));
    }
    const lastRow = rows[rows.length - 1];
    this.stateStore.update(this.id, {
      extra: {
        ...plainObject(state.extra),
        lastUpdatedAt: lastRow.updatedAt,
        lastUpdatedRowId: lastRow.rowId,
        emittedToolResultIds: [...emittedIds].slice(-TOOL_RESULT_DEDUPE_LIMIT),
      },
    });
    return entries;
  }
}

function mapRow(row: MessageRow, emittedIds: Set<string>): AgentActivityEntry[] {
  let parts: unknown;
  try { parts = JSON.parse(row.parts); } catch { return []; }
  if (!Array.isArray(parts)) return [];

  const sessionId = row.sessionId ?? '';
  const timestamp = row.updatedAt > 0 ? row.updatedAt * 1000 : Date.now();
  const model = row.modelLevel || 'unknown';
  if (row.role === 'user') {
    const text = parts
      .filter(part => isObject(part) && part.type === 'text')
      .map(part => stringValue(part.text) || stringValue(part.content))
      .filter(Boolean)
      .join('\n');
    if (!text) return [];
    return [buildAgentActivityEntry({
      timestamp,
      'event.id': hash([sessionId, row.id, 'user']),
      'event.name': 'llm.request',
      'gen_ai.session.id': sessionId,
      'gen_ai.agent.type': ClientType.QwenWorkCN,
      'gen_ai.request.model': model,
      'gen_ai.input.messages_delta': [{ role: 'user', content: text }],
      attributes: {
        source: SOURCE,
        event_kind: 'user_prompt',
        message_id: row.id,
        sub_chat_id: row.subChatId,
        sequence: row.sequence,
      },
    })];
  }
  if (row.role !== 'assistant') return [];

  const entries: AgentActivityEntry[] = [];
  for (const rawPart of parts) {
    if (!isObject(rawPart)) continue;
    const partType = stringValue(rawPart.type);
    if (!partType.startsWith('tool-') || partType === 'tool-Thinking') continue;
    const callId = stringValue(rawPart.toolCallId) || stringValue(rawPart.tool_call_id);
    const toolName = stringValue(rawPart.toolName)
      || stringValue(rawPart.tool_name)
      || stringValue(rawPart.name)
      || partType.slice(5);
    const rawResult = rawPart.output ?? rawPart.result;
    if (!callId || rawResult === undefined) continue;
    const result = jsonValue(rawResult);
    const eventId = hash([sessionId, row.id, 'tool_result', callId, toolName, JSON.stringify(result)]);
    if (emittedIds.has(eventId)) continue;
    emittedIds.add(eventId);
    entries.push(buildAgentActivityEntry({
      timestamp,
      'event.id': eventId,
      'event.name': 'tool.result',
      'gen_ai.session.id': sessionId,
      'gen_ai.agent.type': ClientType.QwenWorkCN,
      'gen_ai.request.model': model,
      'gen_ai.tool.name': toolName,
      'gen_ai.tool.call.id': callId,
      'gen_ai.tool.call.exec.id': callId,
      'gen_ai.tool.call.result': result,
      'tool.result.status': 'success',
      attributes: {
        source: SOURCE,
        event_kind: 'tool_result',
        message_id: row.id,
        sub_chat_id: row.subChatId,
        part_type: partType,
      },
    }));
  }
  return entries;
}

function readRows(dbPath: string, cursorUpdatedAt: number, cursorRowId: number): Promise<MessageRow[]> {
  return all<MessageRow>(dbPath, `
    SELECT m.rowid AS rowId, m.id AS id, sc.session_id AS sessionId, m.sub_chat_id AS subChatId,
      m.sequence AS sequence, m.role AS role, m.parts AS parts,
      m.updated_at AS updatedAt, sc.model_level AS modelLevel
    FROM messages m
    LEFT JOIN sub_chats sc ON sc.id = m.sub_chat_id
    WHERE (m.updated_at > ? OR (m.updated_at = ? AND m.rowid > ?))
      AND m.parts IS NOT NULL AND m.parts != '' AND m.parts != '[]'
    ORDER BY m.updated_at ASC, m.rowid ASC
    LIMIT ${SQL_BATCH_LIMIT}
  `, [cursorUpdatedAt, cursorUpdatedAt, cursorRowId]);
}

async function readLatestCursor(dbPath: string): Promise<{ updatedAt: number; rowId: number }> {
  const rows = await all<{ updatedAt: number; rowId: number }>(
    dbPath,
    'SELECT updated_at AS updatedAt, rowid AS rowId FROM messages ORDER BY updated_at DESC, rowid DESC LIMIT 1',
    [],
  );
  return rows[0] ?? { updatedAt: 0, rowId: 0 };
}

function all<T>(dbPath: string, sql: string, params: unknown[]): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, error => {
      if (error) reject(error);
    });
    db.all(sql, params, (error, rows) => {
      db.close();
      if (error) reject(error);
      else resolve(rows as T[]);
    });
  });
}

function hash(parts: string[]): string {
  return crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item)]));
  return String(value);
}

function plainObject(value: unknown): Record<string, JsonValue> {
  return isObject(value) ? value as Record<string, JsonValue> : {};
}

function stringArray(value: unknown, key: string): string[] {
  if (!isObject(value) || !Array.isArray(value[key])) return [];
  return value[key].filter((item): item is string => typeof item === 'string');
}
