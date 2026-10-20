import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { restoreHookWrapper } from '../../../src/core/hook-watchdog.js';

const renameState = vi.hoisted(() => ({ calls: 0, failOnce: false }));

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      renameState.calls++;
      if (renameState.failOnce) {
        renameState.failOnce = false;
        throw Object.assign(new Error('temporarily locked'), { code: 'EBUSY' });
      }
      return actual.rename(...args);
    },
  };
});

describe('hook wrapper restoration', () => {
  let root: string | undefined;

  afterEach(async () => {
    renameState.calls = 0;
    renameState.failOnce = false;
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it('retries a transient rename failure and installs complete contents', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-wrapper-rename-'));
    const sourcePath = path.join(root, 'package', 'hook.sh');
    const targetPath = path.join(root, 'installed', 'hook.sh');
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(sourcePath, '#!/bin/sh\necho correct\n', { mode: 0o755 });
    await fs.writeFile(targetPath, 'damaged\n');

    renameState.failOnce = true;
    await restoreHookWrapper({ sourcePath, targetPath });

    expect(renameState.calls).toBe(2);
    expect(await fs.readFile(targetPath, 'utf8')).toBe('#!/bin/sh\necho correct\n');
  });
});
