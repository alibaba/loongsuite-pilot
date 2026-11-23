import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createTempDir, cleanupTempDir } from '../../helpers/fixture-builder.js';
import {
  LegacySlsFailedLogCleanupService,
  isLegacyJsonlName,
  type CleanupFileSystem,
} from '../../../src/core/legacy-sls-failed-log-cleanup-service.js';

function realFileSystem(overrides: Partial<CleanupFileSystem> = {}): CleanupFileSystem {
  return {
    lstat: filePath => fs.lstat(filePath),
    rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
    readdir: directory => fs.readdir(directory, { withFileTypes: true }),
    unlink: filePath => fs.unlink(filePath),
    rmdir: directory => fs.rmdir(directory),
    ...overrides,
  };
}

async function exists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true, () => false);
}

describe('LegacySlsFailedLogCleanupService', () => {
  let tmpDir: string;
  let legacyDir: string;
  let pendingDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir('legacy-sls-cleanup-');
    legacyDir = path.join(tmpDir, 'sls-failed-logs');
    pendingDir = path.join(tmpDir, 'sls-failed-logs.delete-pending');
  });

  afterEach(async () => {
    await cleanupTempDir(tmpDir);
    vi.restoreAllMocks();
  });

  it('schedules cleanup with an unref timer and stop cancels it', () => {
    const service = new LegacySlsFailedLogCleanupService(tmpDir, { startupDelayMs: 60_000 });
    const timerSpy = vi.spyOn(globalThis, 'setTimeout');
    service.start();

    const timer = timerSpy.mock.results[0].value as ReturnType<typeof setTimeout>;
    expect(timer.hasRef()).toBe(false);
    service.stop();
  });

  it('does not touch the filesystem until the startup delay has elapsed', async () => {
    vi.useFakeTimers();
    try {
      const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
      const fileSystem: CleanupFileSystem = {
        lstat: vi.fn().mockRejectedValue(missing),
        rename: vi.fn(),
        readdir: vi.fn(),
        unlink: vi.fn(),
        rmdir: vi.fn(),
      };
      const service = new LegacySlsFailedLogCleanupService(tmpDir, {
        startupDelayMs: 30_000,
        fileSystem,
      });

      service.start();
      expect(fileSystem.lstat).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(29_999);
      expect(fileSystem.lstat).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(fileSystem.lstat).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('renames the legacy directory and unlinks a 10GB sparse file without parsing it', async () => {
    await fs.mkdir(path.join(legacyDir, 'unknown-dir'), { recursive: true });
    const largeFile = path.join(legacyDir, 'internal-sls.jsonl');
    await fs.writeFile(largeFile, '{invalid json');
    await fs.truncate(largeFile, 10 * 1024 * 1024 * 1024);
    await fs.writeFile(path.join(legacyDir, 'user-sls.jsonl'), 'also invalid');
    await fs.writeFile(path.join(legacyDir, 'README.md'), 'keep');

    const delays: number[] = [];
    const service = new LegacySlsFailedLogCleanupService(tmpDir, {
      fileDelayMs: 100,
      delay: async milliseconds => { delays.push(milliseconds); },
    });
    const result = await service.runCleanup();

    expect(result.renamed).toBe(true);
    expect(result.deleted).toBe(2);
    expect(result.logicalBytes).toBeGreaterThanOrEqual(10 * 1024 * 1024 * 1024);
    expect(delays).toEqual([100]);
    expect(await exists(legacyDir)).toBe(false);
    expect(await exists(path.join(pendingDir, 'internal-sls.jsonl'))).toBe(false);
    expect(await exists(path.join(pendingDir, 'README.md'))).toBe(true);
    expect(await exists(path.join(pendingDir, 'unknown-dir'))).toBe(true);
  });

  it('resumes an existing pending directory on the next startup', async () => {
    await fs.mkdir(pendingDir, { recursive: true });
    await fs.writeFile(path.join(pendingDir, 'remaining.jsonl'), 'not parsed');

    const service = new LegacySlsFailedLogCleanupService(tmpDir, { fileDelayMs: 0 });
    const result = await service.runCleanup();

    expect(result.renamed).toBe(false);
    expect(result.deleted).toBe(1);
    expect(await exists(pendingDir)).toBe(false);
  });

  it('retries transient rename failures with bounded backoff', async () => {
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(path.join(legacyDir, 'failed.jsonl'), 'x');
    let attempts = 0;
    const delays: number[] = [];
    const fileSystem = realFileSystem({
      rename: async (oldPath, newPath) => {
        attempts++;
        if (attempts < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        await fs.rename(oldPath, newPath);
      },
    });

    const result = await new LegacySlsFailedLogCleanupService(tmpDir, {
      fileSystem,
      fileDelayMs: 0,
      delay: async milliseconds => { delays.push(milliseconds); },
    }).runCleanup();

    expect(attempts).toBe(3);
    expect(delays).toEqual([250, 1_000]);
    expect(result.deleted).toBe(1);
  });

  it('keeps a file after bounded unlink retries and continues with the next file', async () => {
    await fs.mkdir(pendingDir, { recursive: true });
    await fs.writeFile(path.join(pendingDir, 'busy.jsonl'), 'x');
    await fs.writeFile(path.join(pendingDir, 'ok.jsonl'), 'y');
    let busyAttempts = 0;
    const fileSystem = realFileSystem({
      unlink: async filePath => {
        if (path.basename(filePath) === 'busy.jsonl') {
          busyAttempts++;
          throw Object.assign(new Error('occupied'), { code: 'EPERM' });
        }
        await fs.unlink(filePath);
      },
    });

    const result = await new LegacySlsFailedLogCleanupService(tmpDir, {
      fileSystem,
      fileDelayMs: 0,
      delay: async () => {},
    }).runCleanup();

    expect(busyAttempts).toBe(4);
    expect(result.deleted).toBe(1);
    expect(result.errors).toBe(1);
    expect(await exists(path.join(pendingDir, 'busy.jsonl'))).toBe(true);
    expect(await exists(path.join(pendingDir, 'ok.jsonl'))).toBe(false);
  });

  it('does not follow a symlink used as the legacy root', async () => {
    const outsideDir = path.join(tmpDir, 'outside');
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, 'keep.jsonl'), 'keep');
    await fs.symlink(outsideDir, legacyDir);

    const result = await new LegacySlsFailedLogCleanupService(tmpDir).runCleanup();

    expect(result.skipped).toBe(1);
    expect(await exists(path.join(outsideDir, 'keep.jsonl'))).toBe(true);
    expect((await fs.lstat(legacyDir)).isSymbolicLink()).toBe(true);
  });
});

describe('isLegacyJsonlName', () => {
  it('accepts only non-hidden top-level legacy JSONL names', () => {
    expect(isLegacyJsonlName('internal-sls.jsonl')).toBe(true);
    expect(isLegacyJsonlName('a.jsonl')).toBe(true);
    expect(isLegacyJsonlName('.hidden.jsonl')).toBe(false);
    expect(isLegacyJsonlName('.jsonl')).toBe(false);
    expect(isLegacyJsonlName('notes.txt')).toBe(false);
  });
});
