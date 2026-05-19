import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ClientType, CollectionMethod, ActionType } from '../../../src/types/index.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { BaseHookInput } from '../../../src/inputs/base/base-hook-input.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';
import { buildTestEntry } from '../../helpers/fixture-builder.js';

class TestHookInput extends BaseHookInput {
  readonly id = 'test-hook';
  readonly agentType = ClientType.QoderCliHook;

  transformFn: (record: Record<string, unknown>) => Promise<AgentActivityEntry | null> =
    async (record) => {
      return buildTestEntry({
        filePath: (record.file_path as string) ?? '',
        actionType: ActionType.Edit,
      });
    };

  protected async transformRecord(record: Record<string, unknown>): Promise<AgentActivityEntry | null> {
    return this.transformFn(record);
  }
}

describe('BaseHookInput', () => {
  let tmpDir: string;
  let stateStore: MockStateStore;
  let input: TestHookInput;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-test-'));
    stateStore = new MockStateStore();
    input = new TestHookInput({
      stateStore: stateStore as any,
      logDir: tmpDir,
      logPrefix: 'test-hook',
      pollIntervalMs: 60_000,
    });
  });

  afterEach(async () => {
    if (input.running) await input.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should have correct collectionMethod', () => {
    expect(input.collectionMethod).toBe(CollectionMethod.HookJsonl);
  });

  describe('daily JSONL file reading', () => {
    it('should read from today\'s JSONL file', async () => {
      const today = getTodayDateString();
      const logFile = path.join(tmpDir, `test-hook-${today}.jsonl`);
      await fs.writeFile(logFile, JSON.stringify({ file_path: '/a.ts' }) + '\n');

      const entries: AgentActivityEntry[][] = [];
      input.on('entries', (e: AgentActivityEntry[]) => entries.push(e));

      await input.start();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toHaveLength(1);
      await input.stop();
    });

    it('should return empty if no log file exists', async () => {
      const entries: AgentActivityEntry[][] = [];
      input.on('entries', (e: AgentActivityEntry[]) => entries.push(e));

      await input.start();
      expect(entries).toHaveLength(0);
      await input.stop();
    });
  });

  describe('byte offset incremental reading', () => {
    it('should read only new bytes on subsequent polls', async () => {
      const today = getTodayDateString();
      const logFile = path.join(tmpDir, `test-hook-${today}.jsonl`);

      await fs.writeFile(logFile, JSON.stringify({ file_path: '/first.ts' }) + '\n');

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      await input.stop();
      expect(allEntries).toHaveLength(1);

      await fs.appendFile(logFile, JSON.stringify({ file_path: '/second.ts' }) + '\n');

      const input2 = new TestHookInput({
        stateStore: stateStore as any,
        logDir: tmpDir,
        logPrefix: 'test-hook',
        pollIntervalMs: 60_000,
      });
      const moreEntries: AgentActivityEntry[] = [];
      input2.on('entries', (e: AgentActivityEntry[]) => moreEntries.push(...e));

      await input2.start();
      await input2.stop();
      expect(moreEntries).toHaveLength(1);
      expect(moreEntries[0]!.filePath).toBe('/second.ts');
    });

    it('should not re-read already consumed bytes', async () => {
      const today = getTodayDateString();
      const logFile = path.join(tmpDir, `test-hook-${today}.jsonl`);
      await fs.writeFile(logFile, JSON.stringify({ file_path: '/a.ts' }) + '\n');

      const transformSpy = vi.fn(input.transformFn);
      input.transformFn = transformSpy;

      await input.start();
      expect(transformSpy).toHaveBeenCalledTimes(1);

      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(60_000);
      // No new data, transformRecord should not be called again
      expect(transformSpy).toHaveBeenCalledTimes(1);

      await input.stop();
      vi.useRealTimers();
    });

    it('should recover when file is truncated and stored offset is stale', async () => {
      const today = getTodayDateString();
      const logFile = path.join(tmpDir, `test-hook-${today}.jsonl`);
      await fs.writeFile(logFile, JSON.stringify({ file_path: '/first-entry-with-long-path.ts' }) + '\n');

      await input.start();
      await input.stop();

      // Simulate log truncation/rotation with same file name.
      await fs.writeFile(logFile, JSON.stringify({ file_path: '/short.ts' }) + '\n');

      const input2 = new TestHookInput({
        stateStore: stateStore as any,
        logDir: tmpDir,
        logPrefix: 'test-hook',
        pollIntervalMs: 60_000,
      });
      const entries: AgentActivityEntry[] = [];
      input2.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));

      await input2.start();
      await input2.stop();

      expect(entries).toHaveLength(1);
      expect(entries[0]!.filePath).toBe('/short.ts');
    });
  });

  describe('transformRecord delegation', () => {
    it('should call transformRecord for each JSON line', async () => {
      const today = getTodayDateString();
      const logFile = path.join(tmpDir, `test-hook-${today}.jsonl`);
      const records = [
        { file_path: '/a.ts' },
        { file_path: '/b.ts' },
        { file_path: '/c.ts' },
      ];
      await fs.writeFile(logFile, records.map(r => JSON.stringify(r)).join('\n') + '\n');

      const transformSpy = vi.fn(input.transformFn);
      input.transformFn = transformSpy;

      await input.start();
      expect(transformSpy).toHaveBeenCalledTimes(3);
      await input.stop();
    });

    it('should skip entries when transformRecord returns null', async () => {
      const today = getTodayDateString();
      const logFile = path.join(tmpDir, `test-hook-${today}.jsonl`);
      await fs.writeFile(logFile, JSON.stringify({ skip: true }) + '\n');

      input.transformFn = async () => null;

      const entries: AgentActivityEntry[][] = [];
      input.on('entries', (e: AgentActivityEntry[]) => entries.push(e));

      await input.start();
      expect(entries).toHaveLength(0);
      await input.stop();
    });
  });

  describe('malformed JSON handling', () => {
    it('should skip malformed JSON lines without crashing', async () => {
      const today = getTodayDateString();
      const logFile = path.join(tmpDir, `test-hook-${today}.jsonl`);
      const content = 'not json\n' + JSON.stringify({ file_path: '/ok.ts' }) + '\n';
      await fs.writeFile(logFile, content);

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      expect(allEntries).toHaveLength(1);
      expect(allEntries[0]!.filePath).toBe('/ok.ts');
      await input.stop();
    });

    it('should handle empty file gracefully', async () => {
      const today = getTodayDateString();
      const logFile = path.join(tmpDir, `test-hook-${today}.jsonl`);
      await fs.writeFile(logFile, '');

      const entries: AgentActivityEntry[][] = [];
      input.on('entries', (e: AgentActivityEntry[]) => entries.push(e));

      await input.start();
      expect(entries).toHaveLength(0);
      await input.stop();
    });
  });
});

function getTodayDateString(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
