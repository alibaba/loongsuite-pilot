import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempDir, cleanupTempDir } from '../../helpers/fixture-builder.js';
import {
  getHookAssetLockPath,
  getUpgradeMarkerPath,
  HookAssetLockError,
  hookUpgradeInProgress,
  withHookAssetLock,
} from '../../../src/utils/hook-asset-lock.js';

describe('hook asset lock', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempDir();
  });

  afterEach(async () => {
    await cleanupTempDir(dir);
  });

  it('keeps simultaneous contenders out while a live holder exceeds their wait', async () => {
    let release!: () => void;
    let acquired!: () => void;
    const holderEntered = new Promise<void>((resolve) => { acquired = resolve; });
    const holder = withHookAssetLock(dir, async () => {
      acquired();
      await new Promise<void>((resolve) => { release = resolve; });
    });
    await holderEntered;
    const attempt = vi.fn(async () => {});
    try {
      const results = await Promise.allSettled([
        withHookAssetLock(dir, attempt, 30),
        withHookAssetLock(dir, attempt, 30),
        withHookAssetLock(dir, attempt, 30),
      ]);
      expect(results).toHaveLength(3);
      for (const result of results) {
        expect(result).toMatchObject({ status: 'rejected', reason: expect.any(HookAssetLockError) });
      }
      expect(attempt).not.toHaveBeenCalled();
    } finally {
      release();
      await holder;
    }
    await withHookAssetLock(dir, attempt, 30);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('allows a new holder after the other process exits with an open transaction', async () => {
    const peer = spawn(process.execPath, ['--input-type=module', '--eval', `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.exec('BEGIN IMMEDIATE');
      process.stdout.write('holding\\n');
      setInterval(() => {}, 1000);
    `, getHookAssetLockPath(dir)], { stdio: ['ignore', 'pipe', 'inherit'] });
    const closed = once(peer, 'close');
    try {
      const entered = await Promise.race([
        once(peer.stdout, 'data').then(([bytes]) => String(bytes)),
        closed.then(([code]) => { throw new Error(`lock fixture exited with ${code}`); }),
      ]);
      expect(entered).toBe('holding\n');
      await expect(withHookAssetLock(dir, async () => {}, 30)).rejects.toThrow('hook asset lock busy');
    } finally {
      peer.kill('SIGKILL');
      await closed;
    }

    const results: string[] = [];
    await Promise.all(['a', 'b', 'c'].map((name) => withHookAssetLock(dir, async () => {
      results.push(name);
      await fs.readdir(dir);
      expect(results.at(-1)).toBe(name);
    })));
    expect(results.sort()).toEqual(['a', 'b', 'c']);
  });

  it('releases after action failure and keeps that failure intact', async () => {
    const error = new Error('operation failed');
    await expect(withHookAssetLock(dir, async () => { throw error; })).rejects.toBe(error);
    await expect(withHookAssetLock(dir, async () => 'acquired')).resolves.toBe('acquired');
  });

  it('expires an interrupted marker write based on its modification time', async () => {
    const marker = getUpgradeMarkerPath(dir);
    await fs.writeFile(marker, '');
    expect(await hookUpgradeInProgress(dir)).toBe(true);
    const past = new Date(Date.now() - 11 * 60_000);
    await fs.utimes(marker, past, past);
    expect(await hookUpgradeInProgress(dir)).toBe(false);
  });
});
