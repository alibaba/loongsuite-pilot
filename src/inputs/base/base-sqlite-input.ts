import { CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { BaseInput, type InputOptions } from './base-input.js';

const SQL_BATCH_LIMIT = 1000;
// A single batch per poll would need hundreds of cycles to drain a large backlog,
// so a cycle keeps reading until the backlog is done or this budget is spent. Peak
// memory then tracks the budget instead of the size of the backlog.
const MAX_BATCHES_PER_CYCLE = 10;

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
    const entries: AgentActivityEntry[] = [];
    let cursor = this.stateStore.getRowId(this.id);
    let rowsRead = 0;

    for (let batch = 0; batch < MAX_BATCHES_PER_CYCLE; batch++) {
      let rows: SqliteRow[];

      try {
        rows = await this.readNewRows(cursor, SQL_BATCH_LIMIT);
      } catch (err) {
        this.logger.error('failed to read SQLite rows', { error: String(err) });
        return entries;
      }

      if (rows.length === 0) return entries;

      for (const row of rows) {
        try {
          const entry = await this.transformRow(row);
          if (entry) entries.push(entry);
        } catch (err) {
          this.logger.warn('row transform failed', { rowid: row.rowid, error: String(err) });
        }
        // Advance past rows that throw or yield nothing, so one bad row cannot stall
        // the cursor and make every later cycle re-read it.
        if (row.rowid > cursor) cursor = row.rowid;
      }

      rowsRead += rows.length;
      // Persisted per batch: a shutdown mid-catch-up must not replay what was emitted.
      this.stateStore.setRowId(this.id, cursor);

      if (rows.length < SQL_BATCH_LIMIT) return entries;
    }

    this.logger.info('stopped SQLite catch-up at the per-cycle budget, backlog remains', {
      input: this.id,
      rowsRead,
      cursor,
    });
    return entries;
  }

  /**
   * Query the database for at most `limit` rows with rowid > lastRowId, ordered by
   * rowid ascending. Implementations MUST apply the limit in SQL — that limit is what
   * stops a large backlog from being materialised all at once.
   */
  protected abstract readNewRows(lastRowId: number, limit: number): Promise<SqliteRow[]>;

  /**
   * Transform a database row into a normalized AgentActivityEntry.
   * Return null to skip.
   */
  protected abstract transformRow(row: SqliteRow): Promise<AgentActivityEntry | null>;
}
