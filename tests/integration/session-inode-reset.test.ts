import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ClientType, ActionType } from '../../src/types/index.js';
import type { AgentActivityEntry } from '../../src/types/index.js';
import { OpenclawInput } from '../../src/inputs/openclaw/openclaw-input.js';
import { StateStore } from '../../src/checkpoints/state-store.js';

describe('US3: Session file inode reset', () => {
  let tmpDir: string;
  let stateStore: StateStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inode-test-'));
    stateStore = new StateStore(path.join(tmpDir, 'state.json'));
    await stateStore.load();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should detect inode change and reset offset to 0', async () => {
    const sessionDir = path.join(tmpDir, 'sessions');
    await fs.mkdir(sessionDir, { recursive: true });

    const file = path.join(sessionDir, 'session-inode.jsonl');
    await fs.writeFile(file, JSON.stringify({
      type: 'tool_call',
      tool_name: 'write_file',
      file_path: '/original.ts',
      timestamp: Date.now(),
    }) + '\n');

    const input1 = new OpenclawInput({
      stateStore: stateStore as any,
      sessionDir,
      pollIntervalMs: 60_000,
    });
    const entries1: AgentActivityEntry[] = [];
    input1.on('entries', (e: AgentActivityEntry[]) => entries1.push(...e));

    await input1.start();
    await input1.stop();
    await stateStore.save();

    expect(entries1).toHaveLength(1);
    const stateKey = `openclaw:${file}`;
    expect(stateStore.getOffset(stateKey)).toBeGreaterThan(0);

    // Simulate file rotation: delete and recreate (new inode)
    await fs.unlink(file);
    await fs.writeFile(file, JSON.stringify({
      type: 'tool_call',
      tool_name: 'edit_file',
      file_path: '/rotated.ts',
      timestamp: Date.now(),
    }) + '\n');

    const input2 = new OpenclawInput({
      stateStore: stateStore as any,
      sessionDir,
      pollIntervalMs: 60_000,
    });
    const entries2: AgentActivityEntry[] = [];
    input2.on('entries', (e: AgentActivityEntry[]) => entries2.push(...e));

    await input2.start();
    await input2.stop();

    // After inode change, should re-read from beginning
    expect(entries2).toHaveLength(1);
    expect(entries2[0]!.filePath).toBe('/rotated.ts');
  });
});
