import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { StateStore } from '../../../src/checkpoints/state-store.js';

describe('StateStore', () => {
  let tmpDir: string;
  let filePath: string;
  let store: StateStore;

  beforeEach(async () => {
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

  describe('dirty flag optimization', () => {
    it('should not write when not dirty', async () => {
      await store.load();
      await store.save();

      // File shouldn't exist since we never wrote
      const exists = await fs.stat(filePath).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });

    it('should write when dirty', async () => {
      await store.load();
      store.set('x', { lastOffset: 1 });
      await store.save();

      const exists = await fs.stat(filePath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    it('should clear dirty after save', async () => {
      await store.load();
      store.set('x', { lastOffset: 1 });
      await store.save();
      // Second save should be a no-op (covered by dirty optimization)
      await store.save();
    });
  });
});
