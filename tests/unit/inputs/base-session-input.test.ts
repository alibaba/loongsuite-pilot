import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ClientType, CollectionMethod, ActionType } from '../../../src/types/index.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { BaseSessionInput } from '../../../src/inputs/base/base-session-input.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';
import { buildTestEntry } from '../../helpers/fixture-builder.js';

class TestSessionInput extends BaseSessionInput {
  readonly id = 'test-session';
  readonly agentType = ClientType.QoderWork;

  discoverFn: () => Promise<string[]> = async () => [];
  processLineFn: (record: Record<string, unknown>, filePath: string) => Promise<AgentActivityEntry | null> =
    async (record) => buildTestEntry({ filePath: (record.file_path as string) ?? '' });

  protected async discoverSessionFiles(): Promise<string[]> {
    return this.discoverFn();
  }

  protected async processSessionLine(
    record: Record<string, unknown>,
    filePath: string,
  ): Promise<AgentActivityEntry | null> {
    return this.processLineFn(record, filePath);
  }
}

describe('BaseSessionInput', () => {
  let tmpDir: string;
  let stateStore: MockStateStore;
  let input: TestSessionInput;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-test-'));
    stateStore = new MockStateStore();
    input = new TestSessionInput({
      stateStore: stateStore as any,
      sessionDir: tmpDir,
      filePattern: '*.jsonl',
      pollIntervalMs: 60_000,
    });
  });

  afterEach(async () => {
    if (input.running) await input.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should have correct collectionMethod', () => {
    expect(input.collectionMethod).toBe(CollectionMethod.SessionFilePolling);
  });

  describe('discoverSessionFiles', () => {
    it('should call discoverSessionFiles on each collect cycle', async () => {
      const discoverSpy = vi.fn(async () => []);
      input.discoverFn = discoverSpy;

      await input.start();
      expect(discoverSpy).toHaveBeenCalledOnce();
      await input.stop();
    });
  });

  describe('line-by-line processing', () => {
    it('should process each line in a session file', async () => {
      const file = path.join(tmpDir, 'session.jsonl');
      const records = [
        { file_path: '/a.ts' },
        { file_path: '/b.ts' },
      ];
      await fs.writeFile(file, records.map(r => JSON.stringify(r)).join('\n') + '\n');

      input.discoverFn = async () => [file];
      const processLineSpy = vi.fn(input.processLineFn);
      input.processLineFn = processLineSpy;

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      expect(processLineSpy).toHaveBeenCalledTimes(2);
      expect(allEntries).toHaveLength(2);
      await input.stop();
    });

    it('should pass filePath to processSessionLine', async () => {
      const file = path.join(tmpDir, 'my-session.jsonl');
      await fs.writeFile(file, JSON.stringify({ x: 1 }) + '\n');

      input.discoverFn = async () => [file];
      const receivedPaths: string[] = [];
      input.processLineFn = async (record, fp) => {
        receivedPaths.push(fp);
        return buildTestEntry();
      };

      await input.start();
      expect(receivedPaths).toEqual([file]);
      await input.stop();
    });
  });

  describe('byte offset persistence', () => {
    it('should only read new data on subsequent polls', async () => {
      const file = path.join(tmpDir, 'sess.jsonl');
      await fs.writeFile(file, JSON.stringify({ file_path: '/first.ts' }) + '\n');

      input.discoverFn = async () => [file];
      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      await input.stop();
      expect(allEntries).toHaveLength(1);

      await fs.appendFile(file, JSON.stringify({ file_path: '/second.ts' }) + '\n');

      const input2 = new TestSessionInput({
        stateStore: stateStore as any,
        sessionDir: tmpDir,
        filePattern: '*.jsonl',
        pollIntervalMs: 60_000,
      });
      input2.discoverFn = async () => [file];
      const moreEntries: AgentActivityEntry[] = [];
      input2.on('entries', (e: AgentActivityEntry[]) => moreEntries.push(...e));

      await input2.start();
      await input2.stop();
      expect(moreEntries).toHaveLength(1);
      expect(moreEntries[0]!.filePath).toBe('/second.ts');
    });
  });

  describe('inode change detection', () => {
    it('should reset offset when file is replaced (inode change)', async () => {
      const file = path.join(tmpDir, 'rotated.jsonl');
      await fs.writeFile(file, JSON.stringify({ file_path: '/original.ts' }) + '\n');

      input.discoverFn = async () => [file];
      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      await input.stop();
      expect(allEntries).toHaveLength(1);

      // Simulate file rotation: rename old file first then create new one.
      // Keep old file alive during creation to prevent inode reuse on Linux.
      const oldFile = file + '.old';
      await fs.rename(file, oldFile);
      await fs.writeFile(file, JSON.stringify({ file_path: '/rotated.ts' }) + '\n');
      await fs.unlink(oldFile);

      const input2 = new TestSessionInput({
        stateStore: stateStore as any,
        sessionDir: tmpDir,
        filePattern: '*.jsonl',
        pollIntervalMs: 60_000,
      });
      input2.discoverFn = async () => [file];
      const moreEntries: AgentActivityEntry[] = [];
      input2.on('entries', (e: AgentActivityEntry[]) => moreEntries.push(...e));

      await input2.start();
      await input2.stop();
      // After inode change, offset resets and re-reads from start
      expect(moreEntries).toHaveLength(1);
      expect(moreEntries[0]!.filePath).toBe('/rotated.ts');
    });
  });

  describe('error handling', () => {
    it('should skip files that do not exist', async () => {
      input.discoverFn = async () => [path.join(tmpDir, 'nonexistent.jsonl')];

      const entries: AgentActivityEntry[][] = [];
      input.on('entries', (e: AgentActivityEntry[]) => entries.push(e));

      await input.start();
      expect(entries).toHaveLength(0);
      await input.stop();
    });

    it('should skip malformed JSON lines', async () => {
      const file = path.join(tmpDir, 'bad.jsonl');
      await fs.writeFile(file, 'not-json\n' + JSON.stringify({ file_path: '/ok.ts' }) + '\n');

      input.discoverFn = async () => [file];
      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      expect(allEntries).toHaveLength(1);
      expect(allEntries[0]!.filePath).toBe('/ok.ts');
      await input.stop();
    });
  });
});
