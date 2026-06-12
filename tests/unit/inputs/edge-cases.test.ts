import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ClientType, ActionType, CollectionMethod } from '../../../src/types/index.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { BaseHookInput } from '../../../src/inputs/base/base-hook-input.js';
import { BaseSessionInput } from '../../../src/inputs/base/base-session-input.js';
import { BaseInput } from '../../../src/inputs/base/base-input.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';
import { buildTestEntry } from '../../helpers/fixture-builder.js';

function getTodayDateString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

class EdgeHookInput extends BaseHookInput {
  readonly id = 'edge-hook';
  readonly agentType = ClientType.QoderCliHook;

  protected async transformRecord(record: Record<string, unknown>): Promise<AgentActivityEntry | null> {
    return buildTestEntry({ filePath: (record.file_path as string) ?? '' });
  }
}

class EdgeSessionInput extends BaseSessionInput {
  readonly id = 'edge-session';
  readonly agentType = ClientType.QoderWork;

  private readonly mockDir: string;

  constructor(opts: { stateStore: any; mockDir: string }) {
    super({ stateStore: opts.stateStore, sessionDir: opts.mockDir, filePattern: '*.jsonl', pollIntervalMs: 60_000 });
    this.mockDir = opts.mockDir;
  }

  protected async discoverSessionFiles(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.mockDir);
      return entries.filter(e => e.endsWith('.jsonl')).map(e => path.join(this.mockDir, e));
    } catch { return []; }
  }

  protected async processSessionLine(record: Record<string, unknown>): Promise<AgentActivityEntry | null> {
    return buildTestEntry({ filePath: (record.file_path as string) ?? '' });
  }
}

class EdgeBaseInput extends BaseInput {
  readonly id = 'edge-base';
  readonly agentType = ClientType.Qoder;
  readonly collectionMethod = CollectionMethod.HookJsonl;
  collectFn: () => Promise<AgentActivityEntry[]> = async () => [];
  protected async collect() { return this.collectFn(); }
}

describe('Edge cases', () => {
  let tmpDir: string;
  let stateStore: MockStateStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'edge-'));
    stateStore = new MockStateStore();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('empty file handling', () => {
    it('should handle completely empty JSONL file', async () => {
      const today = getTodayDateString();
      const logFile = path.join(tmpDir, `edge-hook-${today}.jsonl`);
      await fs.writeFile(logFile, '');

      const input = new EdgeHookInput({
        stateStore: stateStore as any, logDir: tmpDir, logPrefix: 'edge-hook', pollIntervalMs: 60_000,
      });
      const entries: AgentActivityEntry[][] = [];
      input.on('entries', (e: AgentActivityEntry[]) => entries.push(e));

      await input.start();
      await input.stop();
      expect(entries).toHaveLength(0);
    });

    it('should handle session file with only empty lines', async () => {
      const file = path.join(tmpDir, 'empty-lines.jsonl');
      await fs.writeFile(file, '\n\n\n');

      const input = new EdgeSessionInput({ stateStore: stateStore as any, mockDir: tmpDir });
      const entries: AgentActivityEntry[][] = [];
      input.on('entries', (e: AgentActivityEntry[]) => entries.push(e));

      await input.start();
      await input.stop();
      expect(entries).toHaveLength(0);
    });
  });

  describe('special character paths', () => {
    it('should handle file paths with spaces', async () => {
      const today = getTodayDateString();
      const logFile = path.join(tmpDir, `edge-hook-${today}.jsonl`);
      await fs.writeFile(logFile, JSON.stringify({ file_path: '/path/with spaces/file.ts' }) + '\n');

      const input = new EdgeHookInput({
        stateStore: stateStore as any, logDir: tmpDir, logPrefix: 'edge-hook', pollIntervalMs: 60_000,
      });
      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      await input.stop();
      expect(allEntries).toHaveLength(1);
      expect(allEntries[0]!.filePath).toBe('/path/with spaces/file.ts');
    });

    it('should handle file paths with unicode characters', async () => {
      const today = getTodayDateString();
      const logFile = path.join(tmpDir, `edge-hook-${today}.jsonl`);
      await fs.writeFile(logFile, JSON.stringify({ file_path: '/项目/源码/文件.ts' }) + '\n');

      const input = new EdgeHookInput({
        stateStore: stateStore as any, logDir: tmpDir, logPrefix: 'edge-hook', pollIntervalMs: 60_000,
      });
      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      await input.stop();
      expect(allEntries).toHaveLength(1);
      expect(allEntries[0]!.filePath).toBe('/项目/源码/文件.ts');
    });
  });

  describe('no new data within poll interval', () => {
    it('should produce no entries when file size has not changed', async () => {
      const today = getTodayDateString();
      const logFile = path.join(tmpDir, `edge-hook-${today}.jsonl`);
      await fs.writeFile(logFile, JSON.stringify({ file_path: '/a.ts' }) + '\n');

      const input = new EdgeHookInput({
        stateStore: stateStore as any, logDir: tmpDir, logPrefix: 'edge-hook', pollIntervalMs: 60_000,
      });
      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      await input.stop();
      expect(allEntries).toHaveLength(1);

      // Second run: no new data
      const input2 = new EdgeHookInput({
        stateStore: stateStore as any, logDir: tmpDir, logPrefix: 'edge-hook', pollIntervalMs: 60_000,
      });
      const newEntries: AgentActivityEntry[] = [];
      input2.on('entries', (e: AgentActivityEntry[]) => newEntries.push(...e));

      await input2.start();
      await input2.stop();
      expect(newEntries).toHaveLength(0);
    });
  });

  describe('mixed valid and invalid JSONL lines', () => {
    it('should process valid lines and skip invalid ones', async () => {
      const today = getTodayDateString();
      const logFile = path.join(tmpDir, `edge-hook-${today}.jsonl`);
      const content = [
        JSON.stringify({ file_path: '/ok1.ts' }),
        'GARBAGE',
        '',
        '   ',
        '{incomplete json',
        JSON.stringify({ file_path: '/ok2.ts' }),
      ].join('\n') + '\n';
      await fs.writeFile(logFile, content);

      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const input = new EdgeHookInput({
        stateStore: stateStore as any, logDir: tmpDir, logPrefix: 'edge-hook', pollIntervalMs: 60_000,
      });
      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      await input.stop();
      expect(allEntries).toHaveLength(2);
    });
  });
});
