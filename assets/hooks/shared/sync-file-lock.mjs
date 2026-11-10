import fs from 'node:fs';
import path from 'node:path';

const LOCK_WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));

/**
 * Exclusive create of `lockFile` (O_EXCL). Holders of one file append without
 * another writer splitting a multi-line JSONL record. A lock older than
 * `staleMs` is removed so a crashed holder cannot block the file forever.
 */
export function withSyncFileLock(lockFile, waitMs, staleMs, action, directoryReady = false) {
  const deadline = Date.now() + waitMs;
  let acquired = false;
  try {
    if (!directoryReady) fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    while (!acquired) {
      try {
        const fd = fs.openSync(lockFile, 'wx');
        acquired = true;
        try { if (directoryReady) fs.writeFileSync(fd, String(process.pid)); }
        finally { fs.closeSync(fd); }
      } catch (err) {
        if (err?.code !== 'EEXIST') return { acquired: false };
        try {
          const stat = fs.statSync(lockFile);
          if (Date.now() - stat.mtimeMs > staleMs) {
            // Raw writers and collector retention publish their PID. A slow
            // live owner must never lose the lock just because a TTL elapsed.
            const owner = Number(fs.readFileSync(lockFile, 'utf8'));
            if (Number.isSafeInteger(owner) && owner > 0) {
              let alive = true;
              try { process.kill(owner, 0); }
              catch (error) { alive = error?.code !== 'ESRCH'; }
              if (alive) {
                if (Date.now() >= deadline) return { acquired: false };
                Atomics.wait(LOCK_WAIT_ARRAY, 0, 0, 10);
                continue;
              }
            }
            fs.unlinkSync(lockFile);
            continue;
          }
        } catch { /* retry acquisition */ }
        if (Date.now() >= deadline) return { acquired: false };
        Atomics.wait(LOCK_WAIT_ARRAY, 0, 0, 10);
      }
    }

    return { acquired: true, value: action() };
  } finally {
    if (acquired) {
      try { fs.unlinkSync(lockFile); } catch { /* best-effort lock cleanup */ }
    }
  }
}
