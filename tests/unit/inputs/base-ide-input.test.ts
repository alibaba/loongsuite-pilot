import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ClientType, CollectionMethod, ActionType } from '../../../src/types/index.js';
import type { AgentActivityEntry, CodeGenerationEvent } from '../../../src/types/index.js';
import { BaseIdeInput } from '../../../src/inputs/base/base-ide-input.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';
import { buildTestEntry, buildTestCodeGenEvent } from '../../helpers/fixture-builder.js';

class TestIdeInput extends BaseIdeInput {
  readonly id = 'test-ide';
  readonly agentType = ClientType.Qoder;

  scanFn: (sinceTs: number) => Promise<CodeGenerationEvent[]> = async () => [];
  buildEntryFn: (event: CodeGenerationEvent) => Promise<AgentActivityEntry | null> =
    async (event) => buildTestEntry({
      filePath: event.filePath,
      actionType: event.actionType,
      timestamp: event.sourceTimestamp,
    });

  protected async scanHistoryEntries(sinceTs: number): Promise<CodeGenerationEvent[]> {
    return this.scanFn(sinceTs);
  }

  protected async buildEntry(event: CodeGenerationEvent): Promise<AgentActivityEntry | null> {
    return this.buildEntryFn(event);
  }
}

describe('BaseIdeInput', () => {
  let tmpDir: string;
  let stateStore: MockStateStore;
  let input: TestIdeInput;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ide-test-'));
    stateStore = new MockStateStore();
    input = new TestIdeInput({
      stateStore: stateStore as any,
      dataRoot: tmpDir,
      snapshotStorePath: path.join(tmpDir, 'snapshot.json'),
      pollIntervalMs: 60_000,
    });
  });

  afterEach(async () => {
    if (input.running) await input.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should have correct collectionMethod', () => {
    expect(input.collectionMethod).toBe(CollectionMethod.IdeSnapshotPolling);
  });

  describe('scanHistoryEntries delegation', () => {
    it('should call scanHistoryEntries with sinceTs', async () => {
      const scanSpy = vi.fn(async () => []);
      input.scanFn = scanSpy;

      await input.start();
      expect(scanSpy).toHaveBeenCalledOnce();
      expect(typeof scanSpy.mock.calls[0]![0]).toBe('number');
      await input.stop();
    });
  });

  describe('SnapshotStore dedup flow', () => {
    it('should process new events and skip already-seen ones', async () => {
      const event1 = buildTestCodeGenEvent({ filePath: '/a.ts', sourceTimestamp: 1000 });
      const event2 = buildTestCodeGenEvent({ filePath: '/a.ts', sourceTimestamp: 1000 });

      vi.useFakeTimers();

      // First cycle: event1 is new, should be processed
      input.scanFn = async () => [event1];
      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      expect(allEntries).toHaveLength(1);

      // Second cycle: same event (same snapshot key), should be skipped
      input.scanFn = async () => [event2];
      await vi.advanceTimersByTimeAsync(60_000);
      expect(allEntries).toHaveLength(1);

      await input.stop();
      vi.useRealTimers();
    });

    it('should process events with different keys', async () => {
      const event1 = buildTestCodeGenEvent({ filePath: '/a.ts', sourceTimestamp: 1000 });
      const event2 = buildTestCodeGenEvent({ filePath: '/b.ts', sourceTimestamp: 2000 });

      input.scanFn = async () => [event1, event2];
      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      expect(allEntries).toHaveLength(2);
      await input.stop();
    });
  });

  describe('buildEntry error handling', () => {
    it('should skip events when buildEntry throws', async () => {
      const event1 = buildTestCodeGenEvent({ filePath: '/fail.ts', sourceTimestamp: 1000 });
      const event2 = buildTestCodeGenEvent({ filePath: '/ok.ts', sourceTimestamp: 2000 });

      let callCount = 0;
      input.buildEntryFn = async (event) => {
        callCount++;
        if (event.filePath === '/fail.ts') throw new Error('build error');
        return buildTestEntry({ filePath: event.filePath });
      };
      input.scanFn = async () => [event1, event2];

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      expect(callCount).toBe(2);
      expect(allEntries).toHaveLength(1);
      expect(allEntries[0]!.filePath).toBe('/ok.ts');
      await input.stop();
    });

    it('should skip events when buildEntry returns null', async () => {
      const event = buildTestCodeGenEvent();
      input.buildEntryFn = async () => null;
      input.scanFn = async () => [event];

      const entries: AgentActivityEntry[][] = [];
      input.on('entries', (e: AgentActivityEntry[]) => entries.push(e));

      await input.start();
      expect(entries).toHaveLength(0);
      await input.stop();
    });
  });

  describe('SnapshotStore flush', () => {
    it('should flush snapshot store after collect', async () => {
      const event = buildTestCodeGenEvent({ filePath: '/x.ts', sourceTimestamp: 5000 });
      input.scanFn = async () => [event];

      await input.start();
      // After collect, snapshot store should have been flushed to disk
      const snapshotFile = path.join(tmpDir, 'snapshot.json');
      const exists = await fs.stat(snapshotFile).then(() => true).catch(() => false);
      expect(exists).toBe(true);
      await input.stop();
    });
  });
});
