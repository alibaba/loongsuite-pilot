import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Probe passed to `node -e` before an upgrade is activated.
 * Node < 22.5 has no node:sqlite and exits 0 (SQLite-backed agents degrade).
 * Node >= 22.5 must actually load the builtin, or activation stops.
 */
export const NODE_SQLITE_PROBE =
  "const [M,m]=process.versions.node.split('.').map(Number);if(M>22||(M===22&&m>=5))require('node:sqlite')";

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

/** Node >= 22.5 ships DatabaseSync. Older runtimes return null; never throws. */
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
    return Promise.reject(new Error('node:sqlite is unavailable; SQLite reads require Node.js >= 22.5'));
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
