import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  renameSyncWithRetry,
  sanitizeSessionId,
  withSessionStateLock,
} from '../../../../assets/hooks/grok-build/state.mjs';

let dataDir;
let previousDataDir;

beforeEach(() => {
  previousDataDir = process.env.LOONGSUITE_PILOT_DATA_DIR;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-state-lock-'));
  process.env.LOONGSUITE_PILOT_DATA_DIR = dataDir;
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.LOONGSUITE_PILOT_DATA_DIR;
  else process.env.LOONGSUITE_PILOT_DATA_DIR = previousDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const lockPath = sessionId => path.join(
  dataDir,
  'state',
  'grok-build',
  'sessions',
  `${sanitizeSessionId(sessionId)}.lock`,
);

describe('Grok session state lock', () => {
  test('serializes same-session transactions and removes the owned lock', async () => {
    const order = [];
    const first = withSessionStateLock('same-session', async () => {
      order.push('first-start');
      await wait(60);
      order.push('first-end');
    });
    await wait(10);
    const second = withSessionStateLock('same-session', async () => {
      order.push('second-start');
      order.push('second-end');
    });
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second-start', 'second-end']);
    expect(fs.existsSync(lockPath('same-session'))).toBe(false);
  });

  test('recovers a stale lock and keeps collision-resistant state names', async () => {
    expect(sanitizeSessionId('../same')).not.toBe(sanitizeSessionId('same'));
    const file = lockPath('stale-session');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ token: 'stale' }), { mode: 0o600 });
    const stale = new Date(Date.now() - 60_000);
    fs.utimesSync(file, stale, stale);

    await withSessionStateLock('stale-session', async () => {
      expect(fs.existsSync(file)).toBe(true);
    }, { staleMs: 1_000 });
    expect(fs.existsSync(file)).toBe(false);
  });

  test('classifies bounded lock acquisition timeouts', async () => {
    const first = withSessionStateLock('timeout-session', () => wait(150));
    await wait(10);
    await expect(withSessionStateLock('timeout-session', async () => {}, {
      timeoutMs: 50,
      retryMs: 5,
    })).rejects.toMatchObject({
      name: 'GrokStateLockTimeoutError',
      code: 'STATE_LOCK_TIMEOUT',
    });
    await first;
  });

  test('retries transient Windows rename errors before surfacing failure', () => {
    const source = path.join(dataDir, 'source.tmp');
    const destination = path.join(dataDir, 'destination.json');
    fs.writeFileSync(source, 'state');
    const originalRename = fs.renameSync.bind(fs);
    const rename = vi.spyOn(fs, 'renameSync')
      .mockImplementationOnce(() => {
        const error = new Error('temporarily locked');
        error.code = 'EPERM';
        throw error;
      })
      .mockImplementation((...args) => originalRename(...args));
    try {
      renameSyncWithRetry(source, destination);
      expect(rename).toHaveBeenCalledTimes(2);
      expect(fs.readFileSync(destination, 'utf8')).toBe('state');
    } finally {
      rename.mockRestore();
    }
  });
});
