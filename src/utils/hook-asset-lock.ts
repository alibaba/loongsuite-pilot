import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { loadDatabaseSync, type DatabaseSyncInstance } from './node-sqlite.js';

const HOOK_ASSET_LOCK_WAIT_MS = 15_000;
const HOOK_ASSET_LOCK_POLL_MS = 20;
const HOOK_UPGRADE_MAX_AGE_MS = 10 * 60 * 1000;
const SQLITE_BUSY = 5;

export function getHookAssetLockPath(controlDir: string): string {
  return path.join(controlDir, 'hook-asset-lock.sqlite');
}

export function getUpgradeMarkerPath(controlDir: string): string {
  return path.join(controlDir, 'hook-upgrade-in-progress');
}

export async function hookUpgradeInProgress(controlDir: string): Promise<boolean> {
  const marker = getUpgradeMarkerPath(controlDir);
  try {
    const text = (await fs.readFile(marker, 'utf8')).trim();
    const recorded = Number(text);
    const started = text && Number.isFinite(recorded) ? recorded : (await fs.stat(marker)).mtimeMs;
    return Date.now() - started < HOOK_UPGRADE_MAX_AGE_MS;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/** Acquisition failure only. Errors from the protected action propagate unchanged. */
export class HookAssetLockError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'HookAssetLockError';
  }
}

/**
 * A dedicated SQLite write transaction uses native file locking across processes.
 * Keep the database inode in place. Closing the connection or process exit
 * releases the transaction, so a slow live holder never needs stale-file recovery.
 */
export async function withHookAssetLock<T>(
  controlDir: string,
  body: () => Promise<T>,
  waitMs = HOOK_ASSET_LOCK_WAIT_MS,
): Promise<T> {
  let db: DatabaseSyncInstance | undefined;
  try {
    try {
      await fs.mkdir(controlDir, { recursive: true });
      const Database = loadDatabaseSync();
      if (!Database) throw new Error('Hook asset locking requires node:sqlite');
      db = new Database(getHookAssetLockPath(controlDir));
      db.exec('PRAGMA busy_timeout = 0');
      const deadline = performance.now() + waitMs;
      for (;;) {
        try {
          db.exec('BEGIN IMMEDIATE');
          break;
        } catch (err) {
          const { code, errcode } = err as { code?: string; errcode?: number };
          if (code !== 'ERR_SQLITE_ERROR' || typeof errcode !== 'number' || (errcode & 0xff) !== SQLITE_BUSY) throw err;
          const remaining = deadline - performance.now();
          if (remaining <= 0) throw new Error('hook asset lock busy');
          await delay(Math.min(remaining, HOOK_ASSET_LOCK_POLL_MS));
        }
      }
    } catch (err) {
      throw new HookAssetLockError(err);
    }
    return await body();
  } finally {
    db?.close();
  }
}
