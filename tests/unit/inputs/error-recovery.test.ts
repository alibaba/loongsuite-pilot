import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ClientType, CollectionMethod, ActionType } from '../../../src/types/index.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { BaseHookInput } from '../../../src/inputs/base/base-hook-input.js';
import { BaseInput } from '../../../src/inputs/base/base-input.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';
import { buildTestEntry } from '../../helpers/fixture-builder.js';

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => mockLogger,
}));

function getTodayDateString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

class ErrorTestHookInput extends BaseHookInput {
  readonly id = 'err-hook';
  readonly agentType = ClientType.QoderCliHook;

  protected async transformRecord(record: Record<string, unknown>): Promise<AgentActivityEntry | null> {
    return buildTestEntry({
      filePath: (record.file_path as string) ?? '',
      actionType: ActionType.Edit,
    });
  }
}

class ErrorTestInput extends BaseInput {
  readonly id = 'err-input';
  readonly agentType = ClientType.Qoder;
  readonly collectionMethod = CollectionMethod.HookJsonl;

  callCount = 0;
  collectFn: () => Promise<AgentActivityEntry[]> = async () => [];

  protected async collect(): Promise<AgentActivityEntry[]> {
    this.callCount++;
    return this.collectFn();
  }
}

describe('US4: Error recovery', () => {
  let tmpDir: string;
  let stateStore: MockStateStore;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'err-test-'));
    stateStore = new MockStateStore();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('malformed JSON warning', () => {
    it('should emit warn log for malformed JSONL but continue processing', async () => {
      const today = getTodayDateString();
      const logFile = path.join(tmpDir, `err-hook-${today}.jsonl`);
      await fs.writeFile(logFile,
        'BAD_JSON_LINE\n' +
        JSON.stringify({ file_path: '/good.ts' }) + '\n',
      );

      const input = new ErrorTestHookInput({
        stateStore: stateStore as any,
        logDir: tmpDir,
        logPrefix: 'err-hook',
        pollIntervalMs: 60_000,
      });

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      await input.stop();

      expect(allEntries).toHaveLength(1);
      const warnLog = mockLogger.warn.mock.calls.find(call => call[0] === 'invalid JSONL line');
      expect(warnLog).toBeDefined();
      expect(warnLog?.[1]?.line).toContain('BAD_JSON_LINE');
    });
  });

  describe('missing file handling', () => {
    it('should handle missing log file and retry on next cycle', async () => {
      const logDir = path.join(tmpDir, 'nonexistent-dir');

      const input1 = new ErrorTestHookInput({
        stateStore: stateStore as any,
        logDir,
        logPrefix: 'err-hook',
        pollIntervalMs: 60_000,
      });

      const entries1: AgentActivityEntry[] = [];
      input1.on('entries', (e: AgentActivityEntry[]) => entries1.push(...e));

      await input1.start();
      await input1.stop();
      expect(entries1).toHaveLength(0);

      // Now create the file and run again
      const today = getTodayDateString();
      await fs.mkdir(logDir, { recursive: true });
      await fs.writeFile(
        path.join(logDir, `err-hook-${today}.jsonl`),
        JSON.stringify({ file_path: '/recovered.ts' }) + '\n',
      );

      const input2 = new ErrorTestHookInput({
        stateStore: stateStore as any,
        logDir,
        logPrefix: 'err-hook',
        pollIntervalMs: 60_000,
      });
      const entries2: AgentActivityEntry[] = [];
      input2.on('entries', (e: AgentActivityEntry[]) => entries2.push(...e));

      await input2.start();
      await input2.stop();
      expect(entries2).toHaveLength(1);
    });
  });

  describe('runCycle exception resilience', () => {
    it('should continue polling after collect throws an error', async () => {
      vi.useFakeTimers();

      const input = new ErrorTestInput({ stateStore: stateStore as any, pollIntervalMs: 5_000 });

      let throwOnFirst = true;
      input.collectFn = async () => {
        if (throwOnFirst) {
          throwOnFirst = false;
          throw new Error('transient error');
        }
        return [buildTestEntry()];
      };

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      // First cycle throws, no entries
      expect(allEntries).toHaveLength(0);

      // Second cycle should succeed
      await vi.advanceTimersByTimeAsync(5_000);
      expect(allEntries).toHaveLength(1);

      await input.stop();
    });
  });
});
