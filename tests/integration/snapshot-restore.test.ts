import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { SnapshotStore } from '../../src/checkpoints/snapshot-store.js';

describe('US3: SnapshotStore restore', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snap-r-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should restore processed entries after flush → new instance → load', async () => {
    const filePath = path.join(tmpDir, 'snap.json');

    const store1 = new SnapshotStore(filePath);
    store1.markPending('key-1', 1000);
    store1.markProcessed('key-1');
    store1.markPending('key-2', 2000);
    store1.markProcessed('key-2');
    await store1.flush();

    const store2 = new SnapshotStore(filePath);
    await store2.load();

    expect(store2.shouldProcess('key-1')).toBe(false);
    expect(store2.shouldProcess('key-2')).toBe(false);
    expect(store2.shouldProcess('key-3')).toBe(true);
  });

  it('should restore highWatermark correctly', async () => {
    const filePath = path.join(tmpDir, 'snap-hw.json');

    const store1 = new SnapshotStore(filePath);
    store1.markPending('a', 5000);
    store1.markProcessed('a');
    store1.markPending('b', 10000);
    store1.markProcessed('b');
    await store1.flush();

    const store2 = new SnapshotStore(filePath);
    await store2.load();

    const sinceTs = store2.getSuggestedSinceTimestamp();
    expect(sinceTs).toBeGreaterThanOrEqual(10000);
  });

  it('should handle pending entries across restore', async () => {
    const filePath = path.join(tmpDir, 'snap-pend.json');

    const store1 = new SnapshotStore(filePath);
    store1.markPending('pending-key', 3000);
    await store1.flush();

    const store2 = new SnapshotStore(filePath);
    await store2.load();

    // Pending entries should still be tracked
    expect(store2.shouldProcess('pending-key')).toBe(false);
    expect(store2.size).toBe(1);
  });
});
