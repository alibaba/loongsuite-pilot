import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { SnapshotStore } from '../../../src/checkpoints/snapshot-store.js';

describe('SnapshotStore', () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snap-test-'));
    filePath = path.join(tmpDir, 'snapshot.json');
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('shouldProcess', () => {
    it('should return true for unseen keys', () => {
      const store = new SnapshotStore(filePath);
      expect(store.shouldProcess('key-1')).toBe(true);
    });

    it('should return false for already-seen keys', () => {
      const store = new SnapshotStore(filePath);
      store.markPending('key-1', Date.now());
      expect(store.shouldProcess('key-1')).toBe(false);
    });

    it('should return false for processed keys', () => {
      const store = new SnapshotStore(filePath);
      store.markPending('key-1', Date.now());
      store.markProcessed('key-1');
      expect(store.shouldProcess('key-1')).toBe(false);
    });
  });

  describe('markPending/markProcessed state transitions', () => {
    it('should transition from pending to processed', () => {
      const store = new SnapshotStore(filePath);
      store.markPending('k', 1000);
      store.markProcessed('k');
      expect(store.shouldProcess('k')).toBe(false);
    });

    it('should track size correctly', () => {
      const store = new SnapshotStore(filePath);
      expect(store.size).toBe(0);
      store.markPending('a', 100);
      expect(store.size).toBe(1);
      store.markPending('b', 200);
      expect(store.size).toBe(2);
    });
  });

  describe('highWatermark', () => {
    it('should update highWatermark on markProcessed', () => {
      const store = new SnapshotStore(filePath);
      store.markPending('a', 1000);
      store.markProcessed('a');
      store.markPending('b', 2000);
      store.markProcessed('b');

      const ts = store.getSuggestedSinceTimestamp();
      expect(ts).toBeGreaterThanOrEqual(2000);
    });

    it('should use retention floor if highWatermark is 0', () => {
      vi.useFakeTimers({ now: 1_000_000_000 });
      const retentionMs = 100_000;
      const store = new SnapshotStore(filePath, retentionMs);
      const ts = store.getSuggestedSinceTimestamp();
      expect(ts).toBe(1_000_000_000 - retentionMs);
    });
  });

  describe('prune', () => {
    it('should remove entries older than retention period on flush', async () => {
      vi.useFakeTimers({ now: 1000 });
      const retentionMs = 500;
      const store = new SnapshotStore(filePath, retentionMs);

      store.markPending('old', 100);
      store.markProcessed('old');

      vi.advanceTimersByTime(600);

      store.markPending('new', 1500);
      store.markProcessed('new');

      await store.flush();
      expect(store.size).toBe(1);
      expect(store.shouldProcess('old')).toBe(true);
      expect(store.shouldProcess('new')).toBe(false);
    });
  });

  describe('load/flush persistence', () => {
    it('should persist and restore state', async () => {
      const store1 = new SnapshotStore(filePath);
      store1.markPending('key-a', 1000);
      store1.markProcessed('key-a');
      store1.markPending('key-b', 2000);
      await store1.flush();

      const store2 = new SnapshotStore(filePath);
      await store2.load();
      expect(store2.shouldProcess('key-a')).toBe(false);
      expect(store2.shouldProcess('key-b')).toBe(false);
      expect(store2.size).toBe(2);
    });

    it('should handle missing file on load', async () => {
      const missingPath = path.join(tmpDir, 'missing.json');
      const store = new SnapshotStore(missingPath);
      await store.load();
      expect(store.size).toBe(0);
    });

    it('should restore highWatermark from persisted entries', async () => {
      const store1 = new SnapshotStore(filePath);
      store1.markPending('a', 5000);
      store1.markProcessed('a');
      await store1.flush();

      const store2 = new SnapshotStore(filePath);
      await store2.load();
      const ts = store2.getSuggestedSinceTimestamp();
      expect(ts).toBeGreaterThanOrEqual(5000);
    });
  });
});
