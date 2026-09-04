import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AgentActivityEntry } from '../../src/types/index.js';
import { QoderTraceInput } from '../../src/inputs/qoder-trace/qoder-trace-input.js';
import { StateStore } from '../../src/checkpoints/state-store.js';

function getTodayDateString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function makeRecord(turn: string, index: number): string {
  return JSON.stringify({
    'event.name': 'tool.result',
    'event.id': `${turn}-${index}`,
    'gen_ai.turn.id': turn,
    'gen_ai.step.id': `${turn}:s1`,
    'gen_ai.session.id': 'restart-sess',
    'gen_ai.agent.type': 'qoder-cli',
    'gen_ai.tool.name': 'write_to_file',
    'gen_ai.tool.call.id': `${turn}-call-${index}`,
    'tool.result.status': 'success',
    'agent.source': 'qoder-transcript-hook',
    time_unix_nano: `17800000${String(index).padStart(2, '0')}000000000`,
    observed_time_unix_nano: `17800000${String(index).padStart(2, '0')}000000000`,
  }) + '\n';
}

// What is under test here is not the read loop — base-hook-input.test.ts and the
// qoder-trace unit tests cover that — but that the offset survives a real
// StateStore round trip through the filesystem, which is what a process restart
// actually depends on.
describe('US3: End-to-end restart recovery (offset persisted across processes)', () => {
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

    const store1 = new StateStore(statePath);
    await store1.load();

    // Pre-existing bytes are baselined rather than replayed, so start from an
    // empty file: everything below is an append, the ordering a live collector sees.
    await fs.writeFile(logFile, '');
    const baseline = new QoderTraceInput({ stateStore: store1 as any, logDir, pollIntervalMs: 60_000 });
    await baseline.start();
    await baseline.stop();

    // --- Phase 1: First run collects N=3 records ---
    await fs.appendFile(logFile, [0, 1, 2].map(i => makeRecord('turn-batch1', i)).join(''));

    const input1 = new QoderTraceInput({ stateStore: store1 as any, logDir, pollIntervalMs: 60_000 });
    const entries1: AgentActivityEntry[] = [];
    input1.on('entries', (e: AgentActivityEntry[]) => entries1.push(...e));

    await input1.start();
    await input1.stop();
    await store1.save();

    expect(entries1).toHaveLength(3);

    // --- Phase 2: Simulate restart — append M=2 new records ---
    await fs.appendFile(logFile, [0, 1].map(i => makeRecord('turn-batch2', i)).join(''));

    // Reload state from persisted file (simulating process restart)
    const store2 = new StateStore(statePath);
    await store2.load();

    const input2 = new QoderTraceInput({ stateStore: store2 as any, logDir, pollIntervalMs: 60_000 });
    const entries2: AgentActivityEntry[] = [];
    input2.on('entries', (e: AgentActivityEntry[]) => entries2.push(...e));

    await input2.start();
    await input2.stop();

    // Should only collect the new M=2 records
    expect(entries2).toHaveLength(2);
    expect(entries2[0]?.['event.name']).toBe('tool.result');
    expect(entries2.map(e => e['event.id'])).toEqual(['turn-batch2-0', 'turn-batch2-1']);
  });
});
