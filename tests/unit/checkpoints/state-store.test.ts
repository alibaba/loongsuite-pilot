import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { StateStore } from '../../../src/checkpoints/state-store.js';
import { writeJsonFile } from '../../../src/utils/fs-utils.js';

vi.mock('../../../src/utils/fs-utils.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/utils/fs-utils.js')>();
  return {
    ...actual,
    writeJsonFile: vi.fn(actual.writeJsonFile),
  };
});

describe('StateStore', () => {
  let tmpDir: string;
  let filePath: string;
  let store: StateStore;

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('../../../src/utils/fs-utils.js')>(
      '../../../src/utils/fs-utils.js',
    );
    vi.mocked(writeJsonFile).mockReset().mockImplementation(actual.writeJsonFile);
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ss-test-'));
    filePath = path.join(tmpDir, 'state.json');
    store = new StateStore(filePath);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('load/save lifecycle', () => {
    it('should start with empty state', async () => {
      await store.load();
      expect(store.get('unknown')).toEqual({});
    });

    it('should persist state across save/load', async () => {
      await store.load();
      store.set('input-a', { lastOffset: 100, lastRowId: 5 });
      await store.save();

      const store2 = new StateStore(filePath);
      await store2.load();
      expect(store2.get('input-a')).toEqual({ lastOffset: 100, lastRowId: 5 });
    });

    it('should handle missing file gracefully', async () => {
      const missingPath = path.join(tmpDir, 'nonexistent.json');
      const s = new StateStore(missingPath);
      await s.load();
      expect(s.get('any')).toEqual({});
    });

    it('should handle corrupt JSON gracefully', async () => {
      await fs.writeFile(filePath, 'not json!!', 'utf-8');
      await store.load();
      expect(store.get('any')).toEqual({});
    });
  });

  describe('get/set/update', () => {
    beforeEach(async () => {
      await store.load();
    });

    it('should get empty state for unknown id', () => {
      expect(store.get('nonexistent')).toEqual({});
    });

    it('should set and retrieve state', () => {
      store.set('x', { lastOffset: 42 });
      expect(store.get('x').lastOffset).toBe(42);
    });

    it('should update partial state without losing existing fields', () => {
      store.set('x', { lastOffset: 10, lastRowId: 20 });
      store.update('x', { lastOffset: 30 });
      const state = store.get('x');
      expect(state.lastOffset).toBe(30);
      expect(state.lastRowId).toBe(20);
    });

    it('should set state immutably (no reference leaks)', () => {
      const original = { lastOffset: 10, extra: { foo: 'bar' } };
      store.set('x', original);
      original.lastOffset = 999;
      expect(store.get('x').lastOffset).toBe(10);
    });
  });

  describe('getOffset/setOffset', () => {
    beforeEach(async () => {
      await store.load();
    });

    it('should return 0 for unknown input', () => {
      expect(store.getOffset('unknown')).toBe(0);
    });

    it('should set and get offset', () => {
      store.setOffset('input-a', 256);
      expect(store.getOffset('input-a')).toBe(256);
    });
  });

  describe('getRowId/setRowId', () => {
    beforeEach(async () => {
      await store.load();
    });

    it('should return 0 for unknown input', () => {
      expect(store.getRowId('unknown')).toBe(0);
    });

    it('should set and get rowId', () => {
      store.setRowId('input-b', 42);
      expect(store.getRowId('input-b')).toBe(42);
    });
  });

  describe('revision optimization', () => {
    it('should not write without a new revision', async () => {
      await store.load();
      await store.save();

      // File shouldn't exist since we never wrote
      const exists = await fs.stat(filePath).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });

    it('should write when the revision changes', async () => {
      await store.load();
      store.set('x', { lastOffset: 1 });
      await store.save();

      const exists = await fs.stat(filePath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    it('should not rewrite an already persisted revision', async () => {
      await store.load();
      store.set('x', { lastOffset: 1 });
      await store.save();
      // Second save should be a no-op because the revision is persisted.
      await store.save();
    });
  });

  describe('concurrent saves', () => {
    it('serializes saves and persists mutations made during an active write', async () => {
      await store.load();
      store.set('input-a', { lastOffset: 1 });

      let releaseFirstWrite!: () => void;
      const firstWriteReleased = new Promise<void>(resolve => {
        releaseFirstWrite = resolve;
      });
      let notifyFirstWriteStarted!: () => void;
      const firstWriteStarted = new Promise<void>(resolve => {
        notifyFirstWriteStarted = resolve;
      });
      const actual = await vi.importActual<typeof import('../../../src/utils/fs-utils.js')>(
        '../../../src/utils/fs-utils.js',
      );
      let activeWrites = 0;
      let maxActiveWrites = 0;
      let writeCount = 0;
      vi.mocked(writeJsonFile).mockImplementation(async (...args) => {
        activeWrites++;
        maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
        writeCount++;
        try {
          if (writeCount === 1) {
            notifyFirstWriteStarted();
            await firstWriteReleased;
          }
          await actual.writeJsonFile(...args);
        } finally {
          activeWrites--;
        }
      });

      const firstSave = store.save();
      await firstWriteStarted;
      store.update('input-a', { lastOffset: 2 });
      store.set('input-b', { lastRowId: 3 });
      const concurrentSave = store.save();
      releaseFirstWrite();
      await Promise.all([firstSave, concurrentSave]);

      expect(writeCount).toBe(2);
      expect(maxActiveWrites).toBe(1);
      const persisted = JSON.parse(await fs.readFile(filePath, 'utf8')) as Record<string, unknown>;
      expect(persisted).toEqual({
        'input-a': { lastOffset: 2 },
        'input-b': { lastRowId: 3 },
      });
    });

    it('retains an unpersisted revision after a failed write', async () => {
      await store.load();
      store.set('input-a', { lastOffset: 10 });

      const actual = await vi.importActual<typeof import('../../../src/utils/fs-utils.js')>(
        '../../../src/utils/fs-utils.js',
      );
      vi.mocked(writeJsonFile)
        .mockRejectedValueOnce(new Error('synthetic write failure'))
        .mockImplementation(actual.writeJsonFile);

      await expect(store.save()).rejects.toThrow('synthetic write failure');
      await store.save();

      const persisted = JSON.parse(await fs.readFile(filePath, 'utf8')) as Record<string, unknown>;
      expect(persisted).toEqual({ 'input-a': { lastOffset: 10 } });
      expect(writeJsonFile).toHaveBeenCalledTimes(2);
    });
  });
});
