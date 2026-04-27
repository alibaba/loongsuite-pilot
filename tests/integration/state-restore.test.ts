import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { StateStore } from '../../src/checkpoints/state-store.js';

describe('US3: StateStore restore', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sr-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should restore offsets after save → new instance → load cycle', async () => {
    const filePath = path.join(tmpDir, 'state.json');

    const store1 = new StateStore(filePath);
    await store1.load();
    store1.setOffset('agent-a', 1024);
    store1.setOffset('agent-b', 2048);
    store1.setRowId('agent-c', 42);
    await store1.save();

    const store2 = new StateStore(filePath);
    await store2.load();

    expect(store2.getOffset('agent-a')).toBe(1024);
    expect(store2.getOffset('agent-b')).toBe(2048);
    expect(store2.getRowId('agent-c')).toBe(42);
  });

  it('should preserve extra metadata across restore', async () => {
    const filePath = path.join(tmpDir, 'state-extra.json');

    const store1 = new StateStore(filePath);
    await store1.load();
    store1.update('agent-x', {
      lastOffset: 500,
      extra: { inode: 123456, customField: 'value' },
    });
    await store1.save();

    const store2 = new StateStore(filePath);
    await store2.load();

    const restored = store2.get('agent-x');
    expect(restored.lastOffset).toBe(500);
    expect(restored.extra?.inode).toBe(123456);
    expect(restored.extra?.customField).toBe('value');
  });

  it('should handle multiple save/load cycles correctly', async () => {
    const filePath = path.join(tmpDir, 'state-multi.json');

    // Cycle 1
    const s1 = new StateStore(filePath);
    await s1.load();
    s1.setOffset('a', 100);
    await s1.save();

    // Cycle 2
    const s2 = new StateStore(filePath);
    await s2.load();
    expect(s2.getOffset('a')).toBe(100);
    s2.setOffset('a', 200);
    s2.setOffset('b', 50);
    await s2.save();

    // Cycle 3
    const s3 = new StateStore(filePath);
    await s3.load();
    expect(s3.getOffset('a')).toBe(200);
    expect(s3.getOffset('b')).toBe(50);
  });
});
