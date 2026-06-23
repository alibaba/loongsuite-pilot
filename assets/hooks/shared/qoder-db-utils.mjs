import fs from 'node:fs';
import { homedir } from 'node:os';

// node:sqlite is available in Node 22+. Load once at module init.
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch { /* Node < 22 */ }

/**
 * Check if a session exists in the IntelliJ-specific SQLite DB.
 * Returns true  → session found in ~/.qoder/shared_client/cache/db/local.db (IntelliJ)
 * Returns false → DB exists but session not found (Desktop IDE or CLI)
 * Returns null  → DB unavailable or query failed
 */
export function isQoderIdeaSession(sessionId) {
  if (!DatabaseSync) return null;
  const dbPath = homedir() + '/.qoder/shared_client/cache/db/local.db';
  if (!fs.existsSync(dbPath)) return null;
  const db = new DatabaseSync(dbPath, { readonly: true });
  try {
    const row = db.prepare('SELECT 1 FROM chat_session WHERE session_id = ? LIMIT 1').get(sessionId);
    return row !== undefined;
  } catch {
    return null;
  } finally {
    db.close();
  }
}
