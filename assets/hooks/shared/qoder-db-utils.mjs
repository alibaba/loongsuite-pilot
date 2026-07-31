import fs from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';

const require = createRequire(import.meta.url);

// node:sqlite is available in Node 22+. Load it only when Qoder session
// detection is actually requested: this module is also imported by the shared
// event normalizer used by other agents, and eager loading would emit Node's
// SQLite ExperimentalWarning in unrelated hooks such as Claude Code.
// On Node 18 (repo minimum), loading fails gracefully and callers fall back to
// 'qoder' (Desktop IDE) as the safe default.
let DatabaseSync;
function loadDatabaseSync() {
  if (DatabaseSync !== undefined) return DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    DatabaseSync = null;
  }
  return DatabaseSync;
}

// Per-session cache to avoid repeated DB open/close within the same process.
const _cache = new Map();

/**
 * Check if a session exists in the IntelliJ-specific SQLite DB.
 * Returns true  → session found in ~/.qoder/shared_client/cache/db/local.db (IntelliJ)
 * Returns false → DB exists but session not found (Desktop IDE or CLI)
 * Returns null  → DB unavailable or query failed
 *
 * Results are cached per sessionId for the lifetime of the process.
 */
export function isQoderIdeaSession(sessionId) {
  const Database = loadDatabaseSync();
  if (!Database) return null;
  if (_cache.has(sessionId)) return _cache.get(sessionId);

  const dbPath = homedir() + '/.qoder/shared_client/cache/db/local.db';
  if (!fs.existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare('SELECT 1 FROM chat_session WHERE session_id = ? LIMIT 1').get(sessionId);
    const result = row !== undefined;
    _cache.set(sessionId, result);
    return result;
  } catch {
    return null;
  } finally {
    db.close();
  }
}
