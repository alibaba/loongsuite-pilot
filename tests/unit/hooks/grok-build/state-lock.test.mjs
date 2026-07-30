import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lockPath(sessionId) {
  return path.join(
    dataDir,
    'state',
    'grok-build',
    'sessions',
    `${sanitizeSessionId(sessionId)}.lock`,
  );
}

describe('Grok session state lock', () => {
  test('serializes concurrent state transactions for the same session', async () => {
    const order = [];
    const first = withSessionStateLock('same-session', async () => {
      order.push('first-start');
      await wait(80);
      order.push('first-end');
    });
    await wait(10);
    const second = withSessionStateLock('same-session', async () => {
      order.push('second-start');
      order.push('second-end');
    });

    await Promise.all([first, second]);
    expect(order).toEqual([
      'first-start',
      'first-end',
      'second-start',
      'second-end',
    ]);
    expect(fs.existsSync(lockPath('same-session'))).toBe(false);
  });

  test('recovers a stale lock without deleting the new owner lock early', async () => {
    const file = lockPath('stale-session');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ token: 'stale' }), 'utf-8');
    const stale = new Date(Date.now() - 60_000);
    fs.utimesSync(file, stale, stale);

    let called = false;
    await withSessionStateLock('stale-session', async () => {
      called = true;
      expect(fs.existsSync(file)).toBe(true);
    }, { staleMs: 1_000 });

    expect(called).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });
});
