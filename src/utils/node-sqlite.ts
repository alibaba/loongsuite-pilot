import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Probe passed to `node -e` before an upgrade is activated.
 * It must actually load node:sqlite. A version check that skips require()
 * exits 0 on Node 20 and on 22.0–22.12 / 23.0–23.3, so the upgrade looks
 * successful and later SQLite reads fail. Any failure here is non-zero:
 * activation stops and the previous version stays.
 */
export const NODE_SQLITE_PROBE = "require('node:sqlite')";

/** Max rows one synchronous DatabaseSync.all() may materialize. */
export const SQLITE_SYNC_PAGE = 1000;

interface StatementSync {
  all(...params: unknown[]): unknown[];
}

interface DatabaseSyncInstance {
  prepare(sql: string): StatementSync;
  close(): void;
}

interface DatabaseSyncConstructor {
  new (path: string, options?: { readOnly?: boolean }): DatabaseSyncInstance;
}

let cached: DatabaseSyncConstructor | null | undefined;

/** Unflagged DatabaseSync, or null when this Node cannot load it. Never throws. */
export function loadDatabaseSync(): DatabaseSyncConstructor | null {
  if (cached !== undefined) return cached;
  try {
    const mod = require('node:sqlite') as { DatabaseSync?: DatabaseSyncConstructor };
    cached = mod.DatabaseSync ?? null;
  } catch {
    cached = null;
  }
  return cached;
}

/**
 * Read-only query. Rejects when node:sqlite is missing or the statement fails.
 * Close errors are swallowed so they cannot replace a successful result.
 */
export function queryReadonly<T>(dbPath: string, sql: string, params: readonly unknown[]): Promise<T[]> {
  const DatabaseSync = loadDatabaseSync();
  if (!DatabaseSync) {
    return Promise.reject(new Error(
      'node:sqlite is unavailable; SQLite reads require unflagged node:sqlite (Node.js >= 22.13 or >= 23.4)',
    ));
  }
  let db: DatabaseSyncInstance | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    return Promise.resolve(db.prepare(sql).all(...params) as T[]);
  } catch (err) {
    return Promise.reject(err);
  } finally {
    try { db?.close(); } catch { /* a failed close must not hide the rows */ }
  }
}

export interface SqlitePageCursor {
  continued: number;
  sort: number;
  id: string;
}

/**
 * Run `sql` in pages of SQLITE_SYNC_PAGE. `sql` must include this predicate
 * and must not already have a LIMIT:
 *   AND (? = 0 OR <sort> > ? OR (<sort> = ? AND <id> > ?))
 *   ORDER BY <sort> ASC, <id> ASC
 * Each page is one synchronous all(); a full page yields to the event loop
 * before the next one so a large session cannot stall heartbeats.
 */
export async function queryReadonlyPaged<T>(
  dbPath: string,
  sql: string,
  paramsFor: (cursor: SqlitePageCursor) => readonly unknown[],
  cursorFrom: (row: T) => { sort: number; id: string },
): Promise<T[]> {
  const pagedSql = `${sql}\nLIMIT ${SQLITE_SYNC_PAGE}`;
  const rows: T[] = [];
  let cursor: SqlitePageCursor = { continued: 0, sort: 0, id: '' };
  for (;;) {
    const page = await queryReadonly<T>(dbPath, pagedSql, paramsFor(cursor));
    if (page.length === 0) return rows;
    rows.push(...page);
    if (page.length < SQLITE_SYNC_PAGE) return rows;
    const next = cursorFrom(page[page.length - 1]!);
    cursor = { continued: 1, sort: next.sort, id: next.id };
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}
