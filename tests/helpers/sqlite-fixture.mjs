import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** True when this Node can open a database. Node 18/20 do not ship node:sqlite. */
export function hasNodeSqlite() {
  try {
    return typeof require('node:sqlite').DatabaseSync === 'function';
  } catch {
    return false;
  }
}

/**
 * Run one statement. No bound params → DatabaseSync.exec (multi-statement SQL
 * is allowed). With params → prepare().run, same `?` placeholders as before.
 */
export function execSql(dbPath, sql, params = []) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    if (params.length === 0) db.exec(sql);
    else db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}
