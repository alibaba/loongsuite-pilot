import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createTempDir, cleanupTempDir } from '../../helpers/fixture-builder.js';
import { RuntimeWriter } from '../../../src/status-bar/runtime-writer.js';
import type { StatusBarConfig } from '../../../src/types/index.js';

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
    const writer = new RuntimeWriter(tmpDir, makeConfig(), '1.2.3');
    writer.start();

    // Give async write time to complete
    await new Promise(r => setTimeout(r, 100));

    const filePath = path.join(tmpDir, 'logs', 'runtime.json');
    const content = JSON.parse(await fs.readFile(filePath, 'utf8'));

    expect(content.status).toBe('active');
    expect(content.packageVersion).toBe('1.2.3');
    expect(content.pid).toBe(process.pid);
    expect(content.updatedAt).toBeTruthy();

    writer.stop();
  });

  it('removes runtime.json on stop', async () => {
    const writer = new RuntimeWriter(tmpDir, makeConfig(), '1.0.0');
    writer.start();
    await new Promise(r => setTimeout(r, 100));

    writer.stop();
    await new Promise(r => setTimeout(r, 100));

    const filePath = path.join(tmpDir, 'logs', 'runtime.json');
    const exists = await fs.access(filePath).then(() => true, () => false);
    expect(exists).toBe(false);
  });

  it('does nothing when disabled', async () => {
    const writer = new RuntimeWriter(tmpDir, makeConfig({ enabled: false }), '1.0.0');
    writer.start();
    await new Promise(r => setTimeout(r, 100));

    const filePath = path.join(tmpDir, 'logs', 'runtime.json');
    const exists = await fs.access(filePath).then(() => true, () => false);
    expect(exists).toBe(false);

    writer.stop();
  });
});
