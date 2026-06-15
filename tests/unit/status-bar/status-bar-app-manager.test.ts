import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createTempDir, cleanupTempDir } from '../../helpers/fixture-builder.js';
import { StatusBarAppManager } from '../../../src/status-bar/status-bar-app-manager.js';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

describe('StatusBarAppManager', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir('status-bar-mgr-test-');
    await fs.mkdir(path.join(tmpDir, 'logs'), { recursive: true });
  });

  afterEach(async () => {
    await cleanupTempDir(tmpDir);
  });

  it('skips on non-darwin platforms', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    try {
      const manager = new StatusBarAppManager({ dataDir: tmpDir, packageVersion: '1.0.0' });
      await manager.syncDesiredState(true);

      const runtimePath = path.join(tmpDir, 'logs', 'status-bar-app-runtime.json');
      const exists = await fs.access(runtimePath).then(() => true, () => false);
      expect(exists).toBe(false);
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform);
      }
    }
  });

  it('stop removes runtime record if it exists', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

    try {
      const runtimePath = path.join(tmpDir, 'logs', 'status-bar-app-runtime.json');
      await fs.writeFile(runtimePath, JSON.stringify({
        executablePath: '/nonexistent/binary',
        packageVersion: '1.0.0',
        pid: 99999999,
        updatedAt: new Date().toISOString(),
      }));

      const manager = new StatusBarAppManager({ dataDir: tmpDir, packageVersion: '1.0.0' });
      await manager.stop('test');

      const exists = await fs.access(runtimePath).then(() => true, () => false);
      expect(exists).toBe(false);
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform);
      }
    }
  });

  it('syncDesiredState(false) calls stop', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

    try {
      const runtimePath = path.join(tmpDir, 'logs', 'status-bar-app-runtime.json');
      await fs.writeFile(runtimePath, JSON.stringify({
        executablePath: '/nonexistent/binary',
        packageVersion: '1.0.0',
        pid: 99999999,
        updatedAt: new Date().toISOString(),
      }));

      const manager = new StatusBarAppManager({ dataDir: tmpDir, packageVersion: '1.0.0' });
      await manager.syncDesiredState(false);

      const exists = await fs.access(runtimePath).then(() => true, () => false);
      expect(exists).toBe(false);
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform);
      }
    }
  });
});
