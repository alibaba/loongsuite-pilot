import fs from 'node:fs';
import path from 'node:path';

const LOCK_WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));

/**
 * Exclusive create of `lockFile` (O_EXCL). Holders of one file append without
 * another writer splitting a multi-line JSONL record. A lock older than
 * `staleMs` is removed so a crashed holder cannot block the file forever.
 */
export function withSyncFileLock(lockFile, waitMs, staleMs, action) {
  const deadline = Date.now() + waitMs;
  let acquired = false;
  try {
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    while (!acquired) {
      try {
        const fd = fs.openSync(lockFile, 'wx');
        fs.closeSync(fd);
        acquired = true;
      } catch (err) {
        if (err?.code !== 'EEXIST') return { acquired: false };
        try {
          const stat = fs.statSync(lockFile);
          if (Date.now() - stat.mtimeMs > staleMs) {
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
