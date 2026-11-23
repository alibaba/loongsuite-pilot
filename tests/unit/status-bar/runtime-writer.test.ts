import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createTempDir, cleanupTempDir } from '../../helpers/fixture-builder.js';
import { RuntimeWriter } from '../../../src/status-bar/runtime-writer.js';
import type { StatusBarConfig } from '../../../src/types/index.js';
import * as fsUtils from '../../../src/utils/fs-utils.js';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

function makeConfig(overrides: Partial<StatusBarConfig> = {}): StatusBarConfig {
  return {
    enabled: true,
    metricsSummaryIntervalMs: 60_000,
    runtimeRefreshIntervalMs: 30_000,
    ...overrides,
  };
}

describe('RuntimeWriter', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir('runtime-writer-test-');
    await fs.mkdir(path.join(tmpDir, 'logs'), { recursive: true });
  });

  afterEach(async () => {
    await cleanupTempDir(tmpDir);
  });

  it('writes runtime.json on start', async () => {
    const writer = new RuntimeWriter(tmpDir, makeConfig(), '1.2.3', 'abc123');
    writer.start();

    const filePath = path.join(tmpDir, 'logs', 'runtime.json');
    const content = await vi.waitFor(async () => JSON.parse(await fs.readFile(filePath, 'utf8')));

    expect(content.status).toBe('active');
    expect(content.packageVersion).toBe('1.2.3');
    expect(content.gitCommit).toBe('abc123');
    expect(content.pid).toBe(process.pid);
    expect(content.updatedAt).toBeTruthy();

    await writer.stop();
  });

  it('removes runtime.json on stop', async () => {
    const writer = new RuntimeWriter(tmpDir, makeConfig(), '1.0.0');
    writer.start();
    const filePath = path.join(tmpDir, 'logs', 'runtime.json');
    await vi.waitFor(() => fs.access(filePath));

    await writer.stop();
    await expect(fs.access(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not recreate runtime.json when a heartbeat write is already in flight at stop', async () => {
    let allowWrite!: () => void;
    let finishWrite!: () => void;
    const paused = new Promise<void>(resolve => { allowWrite = resolve; });
    const finished = new Promise<void>(resolve => { finishWrite = resolve; });
    const writeFile = fsUtils.writeJsonFile;
    const write = vi.spyOn(fsUtils, 'writeJsonFile').mockImplementation(async (file, data) => {
      await paused;
      try {
        await writeFile(file, data);
      } finally {
        finishWrite();
      }
    });
    const writer = new RuntimeWriter(tmpDir, makeConfig(), '1.0.0');
    writer.start();
    try {
      await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
      const stopped = writer.stop();
      allowWrite();
      await finished;
      await stopped;

      const file = path.join(tmpDir, 'logs', 'runtime.json');
      await expect(fs.access(file)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      allowWrite();
      await writer.stop();
      write.mockRestore();
    }
  });

  it('writes runtime health when the status bar UI is disabled', async () => {
    const writer = new RuntimeWriter(tmpDir, makeConfig({ enabled: false }), '1.0.0');
    writer.start();
    const filePath = path.join(tmpDir, 'logs', 'runtime.json');
    const content = await vi.waitFor(async () => JSON.parse(await fs.readFile(filePath, 'utf8')));
    expect(content).toMatchObject({
      status: 'active',
      packageVersion: '1.0.0',
      pid: process.pid,
    });

    await writer.stop();
  });
});
