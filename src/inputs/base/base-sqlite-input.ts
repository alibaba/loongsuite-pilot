import { CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { BaseInput, type InputOptions } from './base-input.js';

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
    let rows: SqliteRow[];

    try {
      rows = await this.readNewRows(lastRowId);
    } catch (err) {
      this.logger.error('failed to read SQLite rows', { error: String(err) });
      return [];
    }

    if (rows.length === 0) return [];

    const entries: AgentActivityEntry[] = [];
    let maxRowId = lastRowId;

    for (const row of rows) {
      try {
        const entry = await this.transformRow(row);
        if (entry) entries.push(entry);
        if (row.rowid > maxRowId) maxRowId = row.rowid;
      } catch (err) {
        this.logger.warn('row transform failed', { rowid: row.rowid, error: String(err) });
      }
    }

    this.stateStore.setRowId(this.id, maxRowId);
    return entries;
  }

  /**
   * Query the database for rows with rowid > lastRowId.
   * Override in subclass to implement specific SQL queries.
   */
  protected abstract readNewRows(lastRowId: number): Promise<SqliteRow[]>;

  /**
   * Transform a database row into a normalized AgentActivityEntry.
   * Return null to skip.
   */
  protected abstract transformRow(row: SqliteRow): Promise<AgentActivityEntry | null>;
}
