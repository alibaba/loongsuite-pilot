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

    it('should drain the stored previous-day file before reading today', async () => {
      const today = getTodayDateString();
      const previousDay = addDays(today, -1);
      const previousFileName = `test-hook-${previousDay}.jsonl`;
      const todayFileName = `test-hook-${today}.jsonl`;
      const previousFile = path.join(tmpDir, previousFileName);
      const todayFile = path.join(tmpDir, todayFileName);
      const consumedLine = JSON.stringify({ file_path: '/already-read.ts' }) + '\n';
      await fs.writeFile(previousFile, consumedLine + JSON.stringify({ file_path: '/late-previous.ts' }) + '\n');
      await fs.writeFile(todayFile, JSON.stringify({ file_path: '/today.ts' }) + '\n');
      stateStore.set('test-hook', {
        lastFile: previousFileName,
        lastOffset: Buffer.byteLength(consumedLine),
      });

      const entries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));

      await input.start();
      await input.stop();

      expect(entries.map(e => e.filePath)).toEqual(['/late-previous.ts', '/today.ts']);
      const state = stateStore.get('test-hook');
      expect(state.lastFile).toBe(todayFileName);
      expect(state.extra?.hookLogOffsets).toEqual({
        [previousFileName]: (await fs.stat(previousFile)).size,
        [todayFileName]: (await fs.stat(todayFile)).size,
      });
    });

    it('should not re-ingest history on cold start when only a previous-day file exists', async () => {
      // Collector freshly installed (no prior state), the agent last ran
      // "yesterday", and today's file does not exist yet because the
      // collector's local date still lags the hook writer. Seeding the newest
      // non-today file to 0 here would re-ingest a whole day of already-sent
      // history — the cold-start seed must skip it instead.
      const today = getTodayDateString();
      const previousDay = addDays(today, -1);
      const previousFileName = `test-hook-${previousDay}.jsonl`;
      const previousFile = path.join(tmpDir, previousFileName);
      await fs.writeFile(
        previousFile,
        JSON.stringify({ file_path: '/old-a.ts' }) + '\n' +
        JSON.stringify({ file_path: '/old-b.ts' }) + '\n',
      );

      const entries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));

      await input.start();
      await input.stop();

      expect(entries).toHaveLength(0);
      expect(stateStore.get('test-hook').extra?.hookLogOffsets).toEqual({
        [previousFileName]: (await fs.stat(previousFile)).size,
      });
    });

    it('should prune offsets for daily files that no longer exist on disk', async () => {
      // A stale entry for a rotated-away file must not accumulate in state.
      const today = getTodayDateString();
      const stalePrevious = addDays(today, -30);
      const staleFileName = `test-hook-${stalePrevious}.jsonl`;
      const todayFileName = `test-hook-${today}.jsonl`;
      const todayFile = path.join(tmpDir, todayFileName);
      await fs.writeFile(todayFile, JSON.stringify({ file_path: '/today.ts' }) + '\n');
      stateStore.set('test-hook', {
        lastFile: todayFileName,
        lastOffset: 0,
        extra: {
          hookLogOffsets: {
            [staleFileName]: 999,
            [todayFileName]: 0,
          },
        },
      });

      input.on('entries', () => {});
      await input.start();
      await input.stop();

      const offsets = stateStore.get('test-hook').extra?.hookLogOffsets as Record<string, number>;
      expect(offsets[staleFileName]).toBeUndefined();
      expect(offsets[todayFileName]).toBe((await fs.stat(todayFile)).size);
    });

    it('should keep reading a recent timezone-lagged file after lastFile advances to today', async () => {
      const today = getTodayDateString();
      const previousDay = addDays(today, -1);
      const previousFileName = `test-hook-${previousDay}.jsonl`;
      const todayFileName = `test-hook-${today}.jsonl`;
      const previousFile = path.join(tmpDir, previousFileName);
      const todayFile = path.join(tmpDir, todayFileName);
      const previousConsumed = JSON.stringify({ file_path: '/previous-consumed.ts' }) + '\n';
      const todayConsumed = JSON.stringify({ file_path: '/today-consumed.ts' }) + '\n';
      await fs.writeFile(previousFile, previousConsumed + JSON.stringify({ file_path: '/late-previous.ts' }) + '\n');
      await fs.writeFile(todayFile, todayConsumed);
      stateStore.set('test-hook', {
        lastFile: todayFileName,
        lastOffset: Buffer.byteLength(todayConsumed),
        extra: {
          hookLogOffsets: {
            [previousFileName]: Buffer.byteLength(previousConsumed),
            [todayFileName]: Buffer.byteLength(todayConsumed),
          },
        },
      });

      const entries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));

      await input.start();
      await input.stop();

      expect(entries.map(e => e.filePath)).toEqual(['/late-previous.ts']);
      expect(stateStore.get('test-hook').extra?.hookLogOffsets).toEqual({
        [previousFileName]: (await fs.stat(previousFile)).size,
        [todayFileName]: (await fs.stat(todayFile)).size,
      });
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

function addDays(dateString: string, days: number): string {
  const d = new Date(`${dateString}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
