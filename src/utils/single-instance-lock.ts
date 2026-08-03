import * as fs from 'node:fs';
import * as path from 'node:path';
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
// The lockfile lives at a caller-chosen path (e.g. <dataDir>/logs/collector.lock)
// and holds JSON `{ pid, startedAt }`. Creation is atomic via `fs.openSync(..,'wx')`.

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

// Stale = the recorded holder is no longer the daemon we expect. Age is deliberately
// NOT part of the check: these are long-running daemons, so any age threshold would
// eventually evict a perfectly healthy holder and reopen the very duplication window
// this lock exists to close.
//
// Two conditions make a lock stale:
//  1. The recorded pid is not alive. `isProcessAlive` treats EPERM as alive (matters
//     on Windows, where a foreign-owned process still means "occupied").
//  2. The pid IS alive but its command line is not one of our daemons. On Unix a pid
//     can be recycled after the holder crashes without releasing; the recycled pid
//     would otherwise be misread as a live holder and block every future start. When
//     `patterns` are supplied we verify process identity, so a reused pid running some
//     unrelated program is correctly treated as stale. A pid whose command line still
//     matches is a genuine second daemon — exactly what we want to keep out.
// If the command line can't be read we fail conservative (treat as held, not stale).
function isStale(lock: LockPayload | null, patterns?: readonly ProcessCommandPattern[]): boolean {
  if (!lock) return true;
  if (!isProcessAlive(lock.pid)) return true;
  if (!patterns || patterns.length === 0) return false;
  const command = readProcessCommand(lock.pid);
  if (!command) return false;
  return !isCommandMatch(command, patterns);
}

function writeOwnLock(lockPath: string): void {
  const payload = JSON.stringify({ pid: process.pid, startedAt: Date.now() });
  const handle = fs.openSync(lockPath, 'wx');
  try {
    fs.writeSync(handle, payload);
  } finally {
    fs.closeSync(handle);
  }
}

function makeHandle(lockPath: string): SingleInstanceLock {
  let released = false;
  return {
    path: lockPath,
    release(): void {
      if (released) return;
      released = true;
      try {
        const existing = readLock(lockPath);
        if (existing && existing.pid === process.pid) {
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
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch {
    // If the dir can't be created the openSync below will surface the failure.
  }

  const attempt = (): LockAcquireResult | 'retry' => {
    try {
      writeOwnLock(lockPath);
      return { lock: makeHandle(lockPath) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        // Unexpected fs error: fail closed (do not run) but report no holder.
        return { lock: null };
      }
      const existing = readLock(lockPath);
      if (isStale(existing, patterns)) {
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
