import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ClientType, CollectionMethod, ActionType } from '../../../src/types/index.js';
import type { AgentActivityEntry, CodeGenerationEvent } from '../../../src/types/index.js';
import { BaseIdeInput } from '../../../src/inputs/base/base-ide-input.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';
import { buildTestEntry, buildTestCodeGenEvent } from '../../helpers/fixture-builder.js';
import { AgentActivityEntrySchema } from '../../contract/agent-activity-schema.js';

class MockIdeInput extends BaseIdeInput {
  readonly id = 'mock-ide-agent';
  readonly agentType = ClientType.Qoder;

  events: CodeGenerationEvent[] = [];

  protected async scanHistoryEntries(_sinceTs: number): Promise<CodeGenerationEvent[]> {
    return this.events;
  }

  protected async buildEntry(event: CodeGenerationEvent): Promise<AgentActivityEntry | null> {
    return buildTestEntry({
      agentType: this.agentType,
      actionType: event.actionType,
      filePath: event.filePath,
      timestamp: event.sourceTimestamp,
    });
  }
}

describe('US2: Extensibility - MockIdeInput', () => {
  let tmpDir: string;
  let stateStore: MockStateStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-ide-'));
    stateStore = new MockStateStore();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should call scanHistoryEntries and buildEntry correctly', async () => {
    const input = new MockIdeInput({
      stateStore: stateStore as any,
      dataRoot: tmpDir,
      snapshotStorePath: path.join(tmpDir, 'snap.json'),
      pollIntervalMs: 60_000,
    });

    input.events = [
      buildTestCodeGenEvent({ filePath: '/a.ts', sourceTimestamp: Date.now() }),
      buildTestCodeGenEvent({ filePath: '/b.ts', sourceTimestamp: Date.now() + 1 }),
    ];

    const allEntries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

    await input.start();
    await input.stop();

    expect(allEntries).toHaveLength(2);
  });

  it('should have SnapshotStore dedup managed by base class', async () => {
    const input = new MockIdeInput({
      stateStore: stateStore as any,
      dataRoot: tmpDir,
      snapshotStorePath: path.join(tmpDir, 'snap2.json'),
      pollIntervalMs: 60_000,
    });

    const event = buildTestCodeGenEvent({ filePath: '/dedup.ts', sourceTimestamp: 1000 });
    input.events = [event];

    const allEntries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

    await input.start();
    await input.stop();
    expect(allEntries).toHaveLength(1);

    // Same event again — base class dedup should skip it
    const input2 = new MockIdeInput({
      stateStore: stateStore as any,
      dataRoot: tmpDir,
      snapshotStorePath: path.join(tmpDir, 'snap2.json'),
      pollIntervalMs: 60_000,
    });
    input2.events = [event];
    const newEntries: AgentActivityEntry[] = [];
    input2.on('entries', (e: AgentActivityEntry[]) => newEntries.push(...e));

    await input2.start();
    await input2.stop();
    expect(newEntries).toHaveLength(0);
  });

  it('should produce schema-valid entries', async () => {
    const input = new MockIdeInput({
      stateStore: stateStore as any,
      dataRoot: tmpDir,
      snapshotStorePath: path.join(tmpDir, 'snap3.json'),
      pollIntervalMs: 60_000,
    });
    input.events = [buildTestCodeGenEvent({ filePath: '/valid.ts', sourceTimestamp: Date.now() })];

    const allEntries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

    await input.start();
    await input.stop();

    for (const entry of allEntries) {
      expect(AgentActivityEntrySchema.safeParse(entry).success).toBe(true);
    }
  });

  it('should inherit collectionMethod from BaseIdeInput', () => {
    const input = new MockIdeInput({
      stateStore: stateStore as any,
      dataRoot: tmpDir,
      snapshotStorePath: path.join(tmpDir, 'snap4.json'),
      pollIntervalMs: 60_000,
    });
    expect(input.collectionMethod).toBe(CollectionMethod.IdeSnapshotPolling);
  });
});
