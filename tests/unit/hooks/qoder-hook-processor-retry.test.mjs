import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  isRetryLockStale,
  readRetryLock,
  releaseRetryLock,
  retryLockPath,
  tryAcquireRetryLock,
} from '../../../assets/hooks/qoder-hook-processor.mjs';

let lockDir;

beforeEach(() => {
  lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qodercn-retry-lock-'));
});

afterEach(() => {
  try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('retryLockPath', () => {
  it('hashes transcript path so different paths get different lock files', () => {
    const a = retryLockPath('/tmp/a.jsonl', lockDir);
    const b = retryLockPath('/tmp/b.jsonl', lockDir);
    expect(a).not.toBe(b);
    expect(a.startsWith(lockDir)).toBe(true);
    expect(a.endsWith('.lock')).toBe(true);
  });

  it('returns stable path for same input', () => {
    expect(retryLockPath('/tmp/x.jsonl', lockDir))
      .toBe(retryLockPath('/tmp/x.jsonl', lockDir));
  });
});

describe('tryAcquireRetryLock', () => {
  it('first acquire succeeds and writes pid/sessionId', () => {
    const ok = tryAcquireRetryLock('/tmp/t.jsonl', 'sess-1', lockDir);
    expect(ok).toBe(true);
    const lock = readRetryLock(retryLockPath('/tmp/t.jsonl', lockDir));
    expect(lock.pid).toBe(process.pid);
    expect(lock.sessionId).toBe('sess-1');
    expect(typeof lock.startedAt).toBe('number');
  });

  it('second acquire while live lock exists fails', () => {
    expect(tryAcquireRetryLock('/tmp/t.jsonl', 'sess-1', lockDir)).toBe(true);
    expect(tryAcquireRetryLock('/tmp/t.jsonl', 'sess-1', lockDir)).toBe(false);
  });

  it('overwrites a stale lock (dead pid)', () => {
    const lockPath = retryLockPath('/tmp/t.jsonl', lockDir);
    fs.mkdirSync(lockDir, { recursive: true });
    // PID 1 is init — guaranteed to be unkillable; use a very small fake pid that's almost certainly dead.
    // Use pid=999999 (out of range on most systems) to simulate dead.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, sessionId: 'old', startedAt: Date.now() }));
    expect(tryAcquireRetryLock('/tmp/t.jsonl', 'sess-2', lockDir)).toBe(true);
    const lock = readRetryLock(lockPath);
    expect(lock.sessionId).toBe('sess-2');
  });

  it('overwrites an expired lock (startedAt too old)', () => {
    const lockPath = retryLockPath('/tmp/t.jsonl', lockDir);
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, sessionId: 'old', startedAt: 1 }));
    expect(tryAcquireRetryLock('/tmp/t.jsonl', 'sess-2', lockDir)).toBe(true);
    expect(readRetryLock(lockPath).sessionId).toBe('sess-2');
  });
});

describe('releaseRetryLock', () => {
  it('removes a lock owned by current pid', () => {
    expect(tryAcquireRetryLock('/tmp/t.jsonl', 'sess-1', lockDir)).toBe(true);
    releaseRetryLock('/tmp/t.jsonl', lockDir);
    expect(fs.existsSync(retryLockPath('/tmp/t.jsonl', lockDir))).toBe(false);
  });

  it('leaves a peer pid lock alone', () => {
    const lockPath = retryLockPath('/tmp/t.jsonl', lockDir);
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid + 1, sessionId: 'peer', startedAt: Date.now() }));
    releaseRetryLock('/tmp/t.jsonl', lockDir);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(readRetryLock(lockPath).sessionId).toBe('peer');
  });

  it('does nothing for missing lock', () => {
    expect(() => releaseRetryLock('/tmp/missing.jsonl', lockDir)).not.toThrow();
  });
});

describe('isRetryLockStale', () => {
  it('returns true for null lock', () => {
    expect(isRetryLockStale(null)).toBe(true);
  });

  it('returns true for old lock', () => {
    expect(isRetryLockStale({ pid: process.pid, startedAt: 0 })).toBe(true);
  });

  it('returns false for fresh, live lock', () => {
    expect(isRetryLockStale({ pid: process.pid, startedAt: Date.now() })).toBe(false);
  });

  it('returns true for fresh lock with dead pid', () => {
    expect(isRetryLockStale({ pid: 999999, startedAt: Date.now() })).toBe(true);
  });
});
