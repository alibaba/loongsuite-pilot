import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AgentActivityEntry } from '../../src/types/index.js';
import { QoderCliInput } from '../../src/inputs/qoder-cli/qoder-cli-input.js';
import { StateStore } from '../../src/checkpoints/state-store.js';

function getTodayDateString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

describe('US3: End-to-end restart recovery (BaseHookInput)', () => {
  let tmpDir: string;
  let statePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'restart-'));
    statePath = path.join(tmpDir, 'state.json');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should resume from saved offset after simulated restart', async () => {
    const logDir = path.join(tmpDir, 'logs');
    await fs.mkdir(logDir, { recursive: true });
    const today = getTodayDateString();
    const logFile = path.join(logDir, `qoder-${today}.jsonl`);

    // --- Phase 1: First run collects N=3 records ---
    const batch1 = Array.from({ length: 3 }, (_, i) => ({
      event_type: 'PostToolUse',
      tool_name: 'write_to_file',
      tool_input: { file_path: `/batch1/file${i}.ts`, content: `code ${i}` },
      session_id: 'restart-sess',
      timestamp: Date.now() + i,
    }));
    await fs.writeFile(logFile, batch1.map(r => JSON.stringify(r)).join('\n') + '\n');

    const store1 = new StateStore(statePath);
    await store1.load();

    const input1 = new QoderCliInput({
      stateStore: store1 as any,
      logDir,
      logPrefix: 'qoder',
      pollIntervalMs: 60_000,
    });
    const entries1: AgentActivityEntry[] = [];
    input1.on('entries', (e: AgentActivityEntry[]) => entries1.push(...e));

    await input1.start();
    await input1.stop();
    await store1.save();

    expect(entries1).toHaveLength(3);

    // --- Phase 2: Simulate restart — append M=2 new records ---
    const batch2 = Array.from({ length: 2 }, (_, i) => ({
      event_type: 'PostToolUse',
      tool_name: 'write_to_file',
      tool_input: { file_path: `/batch2/file${i}.ts`, content: `new code ${i}` },
      session_id: 'restart-sess',
      timestamp: Date.now() + 100 + i,
    }));
    await fs.appendFile(logFile, batch2.map(r => JSON.stringify(r)).join('\n') + '\n');

    // Reload state from persisted file (simulating process restart)
    const store2 = new StateStore(statePath);
    await store2.load();

    const input2 = new QoderCliInput({
      stateStore: store2 as any,
      logDir,
      logPrefix: 'qoder',
      pollIntervalMs: 60_000,
    });
    const entries2: AgentActivityEntry[] = [];
    input2.on('entries', (e: AgentActivityEntry[]) => entries2.push(...e));

    await input2.start();
    await input2.stop();

    // Should only collect the new M=2 records
    expect(entries2).toHaveLength(2);
    expect(entries2[0]?.['event.name']).toBe('tool.result');
    expect(entries2[0]?.['agent.file_path']).toBe('/batch2/file0.ts');
    expect(entries2[1]?.['agent.file_path']).toBe('/batch2/file1.ts');
  });
});
