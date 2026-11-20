import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { SQLITE_SYNC_PAGE } from '../../utils/node-sqlite.js';
import { BaseInput, type InputOptions } from './base-input.js';

const MAX_PAGES_PER_CYCLE = 10;

export interface SqliteInputOptions extends InputOptions {
  /** Path to the SQLite database file. */
  dbPath: string;
}

/**
 * Row shape returned by readNewRows(). Each subclass defines its own columns,
 * but rowid and gmtCreate are the minimum for cursor tracking.
 */
export interface SqliteRow {
  rowid: number;
  gmtCreate: number;
  [key: string]: unknown;
}

/**
 * Base input for SQLite database incremental polling.
 * Tracks last rowid as a cursor; subclass implements query and transformation.
 *
 * Subclass must implement:
 *   - readNewRows(): query the SQLite DB for rows after the cursor
 *   - transformRow(): convert a DB row into an AgentActivityEntry
 */
export abstract class BaseSqliteInput extends BaseInput {
  readonly collectionMethod = CollectionMethod.SqlitePolling;

  protected readonly dbPath: string;

  constructor(opts: SqliteInputOptions) {
    super(opts);
    this.dbPath = opts.dbPath;
  }

  protected async collect(): Promise<AgentActivityEntry[]> {
    const lastRowId = this.stateStore.getRowId(this.id);
    const entries: AgentActivityEntry[] = [];
    let cursor = lastRowId;

    for (let page = 0; page < MAX_PAGES_PER_CYCLE; page++) {
      let rows: SqliteRow[];
      try {
        rows = await this.readNewRows(cursor, SQLITE_SYNC_PAGE);
      } catch (err) {
        this.logger.error('failed to read SQLite rows', { error: String(err) });
        break;
      }

      const previousCursor = cursor;
      for (const row of rows) {
        try {
          const entry = await this.transformRow(row);
          if (entry) entries.push(entry);
          cursor = Math.max(cursor, row.rowid);
        } catch (err) {
          this.logger.warn('row transform failed', { rowid: row.rowid, error: String(err) });
        }
      }

      // Leave a failed trailing row for the next poll instead of paging past it.
      if (rows.length < SQLITE_SYNC_PAGE || cursor === previousCursor
        || cursor !== rows.at(-1)?.rowid || page + 1 === MAX_PAGES_PER_CYCLE) {
        break;
      }
      await yieldToEventLoop();
      if (!this.running) break;
    }

    // BaseInput saves after queuing the accumulated entries from this cycle.
    if (cursor !== lastRowId) this.stateStore.setRowId(this.id, cursor);
    return entries;
  }

  /**
   * Query at most `limit` rows with rowid > lastRowId in ascending rowid order.
   * Apply the limit in SQL so the synchronous reader materializes only one page.
   */
  protected abstract readNewRows(lastRowId: number, limit: number): Promise<SqliteRow[]>;

  /**
   * Transform a database row into a normalized AgentActivityEntry.
   * Return null to skip.
   */
  protected abstract transformRow(row: SqliteRow): Promise<AgentActivityEntry | null>;
}
