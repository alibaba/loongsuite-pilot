import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  isProcessAlive,
  readProcessCommand,
  isCommandMatch,
  type ProcessCommandPattern,
} from './pid-utils.js';

// Cross-process single-instance guard backed by a pid lockfile.
//
// Motivation: the collector/updater daemons can be launched more than once on a
// single machine — e.g. the install flow re-registers the scheduled task while a
// previous instance is still running, so `MultipleInstances=IgnoreNew` no longer
// constrains the orphaned one. Multiple daemons then tail the same source and
// append to the same output, duplicating every record. This lock is the process's
// own last line of defense: it must be acquired before the daemon wires up any
// input/output pipeline.
//
// The lockfile lives at a caller-chosen path (e.g. <dataDir>/collector.lock)
// and holds JSON `{ pid, startedAt, ownerId }`. It is published atomically (temp file + hardlink)
// so a peer never observes a created-but-empty lockfile — see `writeOwnLock`.

// Distinguish a lock genuinely held by another async operation in this process
// from a stale lock left by an older process whose pid has since been recycled
// to us. A pid alone cannot make that distinction; the per-acquisition ownerId
// and this process-local map can.
const activeLockOwners = new Map<string, string>();

export interface SingleInstanceLock {
  /** Absolute path of the lockfile this handle owns. */
  readonly path: string;
  /**
   * Release the lock. Idempotent, and only removes the file when this process is
   * still the recorded owner — so a crash-recovery peer that already took over is
   * never clobbered.
   */
  release(): void;
}

export interface LockAcquireResult {
  /** The acquired lock, or null when a live peer already holds it (or on fs error). */
  lock: SingleInstanceLock | null;
  /** pid of the live holder when acquisition failed because one exists. */
  holderPid?: number;
}

interface LockPayload {
  pid: number;
  startedAt: number;
  ownerId?: string;
}

function readLock(lockPath: string): LockPayload | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    if (parsed && typeof parsed === 'object' && typeof (parsed as LockPayload).pid === 'number') {
      return parsed as LockPayload;
    }
  } catch {
    // Missing or malformed lockfile — treat as no lock.
  }
  return null;
}

// A lock is stale when its recorded holder is no longer a daemon we expect. For a *healthy*
// holder age is deliberately NOT part of the check: these are long-running daemons, so any age
// threshold on a matching holder would eventually evict a perfectly healthy one and reopen the
// very duplication window this lock exists to close.
//
// Conditions that make a lock stale:
//  1. The recorded pid is not alive. `isProcessAlive` treats EPERM as alive (matters on
//     Windows, where a foreign-owned process still means "occupied").
//  2. The pid IS alive but its command line is readable and is not one of our daemons. On Unix a
//     pid can be recycled after the holder crashes without releasing; the recycled pid would
//     otherwise be misread as a live holder and block every future start. A readable command line
//     that still matches is a genuine second daemon — exactly what we want to keep out.
//  3. The pid is alive but its command line is UNREADABLE (foreign-owned / permission-denied /
//     transient) AND the lock is implausibly old. We can't confirm identity, so we stay
//     conservative (held) for a fresh lock; but an unreadable holder older than
//     UNREADABLE_HOLDER_MAX_AGE_MS is almost certainly a crashed daemon whose pid was reused by an
//     uninspectable process — without this escape valve such a lock would deadlock every future
//     start forever. Healthy daemons of ours expose a readable, matching command line and take
//     branch 2, so they are never aged out here.
const UNREADABLE_HOLDER_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h — generous; only breaks true deadlocks

function isStale(
  lockPath: string,
  lock: LockPayload | null,
  patterns?: readonly ProcessCommandPattern[],
): boolean {
  if (!lock) return true;
  if (lock.pid === process.pid) {
    return !lock.ownerId || activeLockOwners.get(lockPath) !== lock.ownerId;
  }
  if (!isProcessAlive(lock.pid)) return true;
  if (!patterns || patterns.length === 0) return false;
  const command = readProcessCommand(lock.pid);
  if (!command) {
    return (
      typeof lock.startedAt === 'number' &&
      Date.now() - lock.startedAt > UNREADABLE_HOLDER_MAX_AGE_MS
    );
  }
  return !isCommandMatch(command, patterns);
}

function writeOwnLock(lockPath: string, ownerId: string): void {
  const payload = JSON.stringify({ pid: process.pid, startedAt: Date.now(), ownerId });
  // Atomic publish: write the full payload to a temp file, then hardlink it into place.
  // link(2) is atomic and fails with EEXIST when a holder already exists, so a concurrent
  // reader never observes a created-but-empty lockfile. `openSync(..,'wx')` + `writeSync`
  // is NOT atomic that way: the file exists empty for a window between create and write, and
  // a peer that reads it during that window parses no pid, treats the lock as stale, unlinks
  // it, and both processes end up "holding" it — the exact double-acquire this guard prevents.
  const tmp = `${lockPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, payload);
  try {
    fs.linkSync(tmp, lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') throw err; // a live holder exists
    // Filesystem without hardlink support (some network/FAT mounts): fall back to exclusive
    // create. Narrow non-atomic window, but preserves correctness on such mounts.
    const handle = fs.openSync(lockPath, 'wx');
    try {
      fs.writeSync(handle, payload);
    } finally {
      fs.closeSync(handle);
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* best-effort temp cleanup */ }
  }
}

function makeHandle(lockPath: string, ownerId: string): SingleInstanceLock {
  let released = false;
  activeLockOwners.set(lockPath, ownerId);
  return {
    path: lockPath,
    release(): void {
      if (released) return;
      released = true;
      if (activeLockOwners.get(lockPath) === ownerId) {
        activeLockOwners.delete(lockPath);
      }
      try {
        const existing = readLock(lockPath);
        if (existing && existing.pid === process.pid && existing.ownerId === ownerId) {
          fs.unlinkSync(lockPath);
        }
      } catch {
        // Best-effort: never let lock release crash shutdown.
      }
    },
  };
}

/**
 * Attempt to acquire the single-instance lock at `lockPath`.
 *
 * - No live holder → creates the lockfile atomically and returns a handle.
 * - Live holder → returns `{ lock: null, holderPid }`; the caller should log and exit.
 * - Stale lockfile (dead holder, or a reused pid running a different program) → the
 *   stale file is removed and the lock is taken.
 *
 * When `patterns` are supplied, a lockfile whose pid is alive is only honored if that
 * process's command line matches one of the patterns — closing the Unix pid-reuse
 * window. Omit `patterns` to fall back to a pid-liveness-only check.
 */
export function acquireSingleInstanceLock(
  lockPath: string,
  patterns?: readonly ProcessCommandPattern[],
): LockAcquireResult {
  lockPath = path.resolve(lockPath);
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch {
    // If the dir can't be created the openSync below will surface the failure.
  }

  const attempt = (): LockAcquireResult | 'retry' => {
    try {
      const ownerId = randomUUID();
      writeOwnLock(lockPath, ownerId);
      return { lock: makeHandle(lockPath, ownerId) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        // Unexpected fs error: fail closed (do not run) but report no holder.
        return { lock: null };
      }
      const existing = readLock(lockPath);
      if (isStale(lockPath, existing, patterns)) {
        // Holder is gone — drop the stale file and try once more to take over.
        try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
        return 'retry';
      }
      return { lock: null, holderPid: existing?.pid };
    }
  };

  const first = attempt();
  if (first !== 'retry') return first;
  // A single retry is enough: if a peer wins the race between our unlink and
  // re-create we simply report it as the holder rather than spinning.
  const second = attempt();
  return second === 'retry' ? { lock: null } : second;
}
