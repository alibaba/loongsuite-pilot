import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ClientType, ActionType } from '../../src/types/index.js';
import type { AgentActivityEntry } from '../../src/types/index.js';
import { QoderInput } from '../../src/inputs/qoder/qoder-input.js';
import { StateStore } from '../../src/checkpoints/state-store.js';
import { AgentActivityEntrySchema } from '../contract/agent-activity-schema.js';

describe('IDE snapshot integration flow', () => {
  let tmpDir: string;
  let stateStore: StateStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ide-integ-'));
    stateStore = new StateStore(path.join(tmpDir, 'state.json'));
    await stateStore.load();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should perform complete scan → dedup → normalize → snapshot persist flow', async () => {
    // Set up IDE-like directory structure
    const historyDir = path.join(tmpDir, 'User', 'History', 'hash001');
    await fs.mkdir(historyDir, { recursive: true });

    const now = Date.now();
    const entriesData = {
      resource: '/proj/app.ts',
      entries: [
        { id: 'e1', timestamp: now, source: 'qoder-ai-completion' },
        { id: 'e2', timestamp: now + 1000, source: 'qoder-assistant' },
      ],
    };
    await fs.writeFile(path.join(historyDir, 'entries.json'), JSON.stringify(entriesData));

    const snapshotPath = path.join(tmpDir, 'snapshot.json');
    const input = new QoderInput({
      stateStore: stateStore as any,
      dataRoot: tmpDir,
      snapshotStorePath: snapshotPath,
      pollIntervalMs: 60_000,
    } as any);

    const allEntries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

    await input.start();
    await input.stop();

    // Should have processed the history entries
    expect(allEntries.length).toBeGreaterThanOrEqual(1);

    // All entries should be valid
    for (const entry of allEntries) {
      expect(entry['gen_ai.agent.type']).toBe(ClientType.Qoder);
      const result = AgentActivityEntrySchema.safeParse(entry);
      expect(result.success).toBe(true);
    }

    // Snapshot store should have been persisted
    const snapshotExists = await fs.stat(snapshotPath).then(() => true).catch(() => false);
    expect(snapshotExists).toBe(true);

    // Re-running with same snapshot should not produce duplicates
    const input2 = new QoderInput({
      stateStore: stateStore as any,
      dataRoot: tmpDir,
      snapshotStorePath: snapshotPath,
      pollIntervalMs: 60_000,
    } as any);

    const newEntries: AgentActivityEntry[] = [];
    input2.on('entries', (e: AgentActivityEntry[]) => newEntries.push(...e));

    await input2.start();
    await input2.stop();

    // Deduplication should prevent re-processing
    expect(newEntries).toHaveLength(0);
  });

  it('should integrate with ai_tracker JSONL source', async () => {
    const trackerDir = path.join(tmpDir, 'SharedClientCache', 'cache', 'ai_tracker');
    await fs.mkdir(trackerDir, { recursive: true });

    const trackerFile = path.join(trackerDir, 'track-integ.jsonl');
    await fs.writeFile(trackerFile, JSON.stringify({
      filePath: '/proj/tracked.ts',
      aiAddedLines: ['line 1'],
      aiDeletedLines: [],
      aiModifiedContent: 'content',
    }) + '\n');

    const input = new QoderInput({
      stateStore: stateStore as any,
      dataRoot: tmpDir,
      snapshotStorePath: path.join(tmpDir, 'snap2.json'),
      pollIntervalMs: 60_000,
    } as any);

    const allEntries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

    await input.start();
    await input.stop();

    const trackerEntries = allEntries.filter(e => e['agent.toolName'] === 'qoder-ai-tracker');
    expect(trackerEntries.length).toBeGreaterThanOrEqual(1);

    // Verify offset tracking
    await stateStore.save();
    const offset = stateStore.getOffset('qoder-tracker:track-integ.jsonl');
    expect(offset).toBeGreaterThan(0);
  });
});
