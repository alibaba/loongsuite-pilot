import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(path.join(process.cwd(), '__pilot_raw_gate__.cjs'));
let Database;
function databaseClass() {
  if (Database) return Database;
  const warning = process.emitWarning;
  process.emitWarning = function (...args) {
    if (args[0] === 'SQLite is an experimental feature and might change at any time' && args[1] === 'ExperimentalWarning') return;
    return warning.apply(this, args);
  };
  try {
    try { Database = require('node:sqlite').DatabaseSync; }
    catch (error) {
      if (!globalThis.Bun) throw error;
      Database = require('bun:sqlite').Database;
    }
  } finally { process.emitWarning = warning; }
  return Database;
}

/** One stable OS transaction gate per directory, shared with Python sqlite3.
 * Never unlink this database: that would split the lock domain of open handles.
 * There is no TTL, PID probe, heartbeat, or stale lockfile to reclaim.
 */
export function acquireRawSourceGate(directory) {
  const file = path.join(directory, '.raw-source-gate.sqlite');
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.closeSync(fs.openSync(file, 'wx', 0o600)); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (!fs.lstatSync(file).isFile()) throw new Error('Invalid raw source gate');
  let db;
  try {
    const Class = databaseClass();
    db = new Class(file);
    db.exec('PRAGMA busy_timeout=0');
    db.exec('BEGIN IMMEDIATE');
  } catch (error) {
    try { db?.close(); } catch {}
    if (error.errcode === 5 || error.errcode === 6 || error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED') return null;
    throw error;
  }
  return {
    release() {
      // Closing is independent of ROLLBACK: a failed rollback must not keep
      // the OS lock. No unlink is needed, including on Windows.
      try { db.exec('ROLLBACK'); } finally { db.close(); }
    },
  };
}
