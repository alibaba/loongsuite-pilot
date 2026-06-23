import fs from 'node:fs';
import { homedir } from 'node:os';

// node:sqlite is available in Node 22+. Load once at module init.
// On Node 18 (repo minimum), this fails gracefully and isQoderIdeaSession
// returns null — callers fall back to 'qoder' (Desktop IDE) as safe default.
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch { /* Node < 22: DB detection unavailable, fallback to qoder */ }

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
  if (!DatabaseSync) return null;
  if (_cache.has(sessionId)) return _cache.get(sessionId);

  const dbPath = homedir() + '/.qoder/shared_client/cache/db/local.db';
  if (!fs.existsSync(dbPath)) return null;
  const db = new DatabaseSync(dbPath, { readonly: true });
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
