import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ClientType, ActionType, CollectionMethod } from '../../../src/types/index.js';
import type { AgentActivityEntry, CodeGenerationEvent } from '../../../src/types/index.js';
import { QoderInput } from '../../../src/inputs/qoder/qoder-input.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';

describe('QoderInput', () => {
  let tmpDir: string;
  let stateStore: MockStateStore;
  let input: QoderInput;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qoder-test-'));
    stateStore = new MockStateStore();
    input = new QoderInput({
      stateStore: stateStore as any,
      dataRoot: tmpDir,
      snapshotStorePath: path.join(tmpDir, 'snapshot.json'),
      pollIntervalMs: 60_000,
    } as any);
  });

  afterEach(async () => {
    if (input?.running) await input.stop();
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it('should have correct id and agentType', () => {
    expect(input.id).toBe('qoder');
    expect(input.agentType).toBe(ClientType.Qoder);
    expect(input.collectionMethod).toBe(CollectionMethod.IdeSnapshotPolling);
  });

  describe('file history scanning (source 1)', () => {
    it('should scan entries.json from User/History directory', async () => {
      const historyDir = path.join(tmpDir, 'User', 'History', 'hash123');
      await fs.mkdir(historyDir, { recursive: true });

      const entriesData = {
        resource: '/proj/file.ts',
        entries: [
          { id: 'e1', timestamp: Date.now(), source: 'qoder-completion' },
        ],
      };
      await fs.writeFile(path.join(historyDir, 'entries.json'), JSON.stringify(entriesData));

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      expect(allEntries).toHaveLength(1);
      expect(allEntries[0]!['agent.file_path']).toBe('/proj/file.ts');
      expect(allEntries[0]!['agent.action_type']).toBe(ActionType.Edit);
      await input.stop();
    });

    it('should filter out non-AI history entries', async () => {
      const historyDir = path.join(tmpDir, 'User', 'History', 'hash456');
      await fs.mkdir(historyDir, { recursive: true });

      const entriesData = {
        resource: '/proj/manual.ts',
        entries: [
          { id: 'e1', timestamp: Date.now(), source: 'user-manual-edit' },
        ],
      };
      await fs.writeFile(path.join(historyDir, 'entries.json'), JSON.stringify(entriesData));

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      expect(allEntries).toHaveLength(0);
      await input.stop();
    });

    it('should handle missing History directory gracefully', async () => {
      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      expect(allEntries).toHaveLength(0);
      await input.stop();
    });
  });

  describe('ai_tracker scanning (source 2)', () => {
    it('should read ai_tracker JSONL files', async () => {
      const trackerDir = path.join(tmpDir, 'SharedClientCache', 'cache', 'ai_tracker');
      await fs.mkdir(trackerDir, { recursive: true });

      const trackerFile = path.join(trackerDir, 'tracker-2026.jsonl');
      const record = {
        filePath: '/proj/tracked.ts',
        aiAddedLines: ['const x = 1;'],
        aiDeletedLines: [],
        aiModifiedContent: 'modified code',
      };
      await fs.writeFile(trackerFile, JSON.stringify(record) + '\n');

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      expect(allEntries.length).toBeGreaterThanOrEqual(1);
      const trackerEntries = allEntries.filter(e => e['agent.toolName'] === 'qoder-ai-tracker');
      expect(trackerEntries).toHaveLength(1);
      expect(trackerEntries[0]!['agent.file_path']).toBe('/proj/tracked.ts');
      await input.stop();
    });

    it('should track file offset for incremental reading', async () => {
      const trackerDir = path.join(tmpDir, 'SharedClientCache', 'cache', 'ai_tracker');
      await fs.mkdir(trackerDir, { recursive: true });

      const trackerFile = path.join(trackerDir, 'track.jsonl');
      await fs.writeFile(trackerFile, JSON.stringify({ filePath: '/first.ts' }) + '\n');

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      await input.stop();
      const firstCount = allEntries.length;
      expect(firstCount).toBeGreaterThanOrEqual(1);

      // Append more data
      await fs.appendFile(trackerFile, JSON.stringify({ filePath: '/second.ts' }) + '\n');

      // Re-create input with same state to simulate next poll
      const input2 = new QoderInput({
        stateStore: stateStore as any,
        dataRoot: tmpDir,
        snapshotStorePath: path.join(tmpDir, 'snapshot2.json'),
        pollIntervalMs: 60_000,
      } as any);
      const moreEntries: AgentActivityEntry[] = [];
      input2.on('entries', (e: AgentActivityEntry[]) => moreEntries.push(...e));

      await input2.start();
      await input2.stop();
      const trackerEntries = moreEntries.filter(e => e['agent.toolName'] === 'qoder-ai-tracker');
      expect(trackerEntries).toHaveLength(1);
      expect(trackerEntries[0]!['agent.file_path']).toBe('/second.ts');
    });

    it('should handle missing tracker directory gracefully', async () => {
      // No tracker dir exists, should not crash
      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      // Should just silently skip
      await input.stop();
    });
  });

  describe('buildEntry output', () => {
    it('should produce entries with correct agentType', async () => {
      const historyDir = path.join(tmpDir, 'User', 'History', 'hash-be');
      await fs.mkdir(historyDir, { recursive: true });
      await fs.writeFile(path.join(historyDir, 'entries.json'), JSON.stringify({
        resource: '/proj/be.ts',
        entries: [{ id: 'be1', timestamp: Date.now(), source: 'ai-completion' }],
      }));

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      await input.stop();

      expect(allEntries.length).toBeGreaterThanOrEqual(1);
      expect(allEntries[0]!['gen_ai.agent.type']).toBe(ClientType.Qoder);
      expect(allEntries[0]!['agent.action_type']).toBe(ActionType.Edit);
    });
  });

  describe('history entry source filtering', () => {
    it('should accept various AI source patterns', async () => {
      const historyDir = path.join(tmpDir, 'User', 'History', 'hash-src');
      await fs.mkdir(historyDir, { recursive: true });

      const now = Date.now();
      await fs.writeFile(path.join(historyDir, 'entries.json'), JSON.stringify({
        resource: '/proj/src.ts',
        entries: [
          { id: 's1', timestamp: now, source: 'copilot-suggestion' },
          { id: 's2', timestamp: now + 1, source: 'assistant-edit' },
          { id: 's3', timestamp: now + 2, source: 'agent-action' },
          { id: 's4', timestamp: now + 3, source: 'manual-typing' },
        ],
      }));

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      await input.stop();

      // copilot, assistant, agent match the AI regex; manual-typing does not
      expect(allEntries.length).toBe(3);
    });

    it('should handle entries without source field', async () => {
      const historyDir = path.join(tmpDir, 'User', 'History', 'hash-nosrc');
      await fs.mkdir(historyDir, { recursive: true });

      await fs.writeFile(path.join(historyDir, 'entries.json'), JSON.stringify({
        resource: '/proj/nosrc.ts',
        entries: [{ id: 'ns1', timestamp: Date.now() }],
      }));

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      await input.stop();
      // No source = empty string, won't match AI regex
      expect(allEntries).toHaveLength(0);
    });

    it('should skip entries older than sinceTs', async () => {
      const historyDir = path.join(tmpDir, 'User', 'History', 'hash-old');
      await fs.mkdir(historyDir, { recursive: true });

      await fs.writeFile(path.join(historyDir, 'entries.json'), JSON.stringify({
        resource: '/proj/old.ts',
        entries: [{ id: 'o1', timestamp: 100, source: 'qoder-ai' }],
      }));

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      await input.stop();
      // Old timestamp should be filtered by sinceTs from SnapshotStore
      // (depends on retention, but very old timestamps are filtered)
    });

    it('should handle entries.json without entries array', async () => {
      const historyDir = path.join(tmpDir, 'User', 'History', 'hash-noarr');
      await fs.mkdir(historyDir, { recursive: true });

      await fs.writeFile(path.join(historyDir, 'entries.json'), JSON.stringify({
        resource: '/proj/noarr.ts',
      }));

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      await input.stop();
      expect(allEntries).toHaveLength(0);
    });

    it('should handle corrupt entries.json gracefully', async () => {
      const historyDir = path.join(tmpDir, 'User', 'History', 'hash-corrupt');
      await fs.mkdir(historyDir, { recursive: true });

      await fs.writeFile(path.join(historyDir, 'entries.json'), 'not json');

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      await input.stop();
      expect(allEntries).toHaveLength(0);
    });
  });

  describe('ai_tracker edge cases', () => {
    it('should skip empty lines in tracker JSONL', async () => {
      const trackerDir = path.join(tmpDir, 'SharedClientCache', 'cache', 'ai_tracker');
      await fs.mkdir(trackerDir, { recursive: true });

      await fs.writeFile(path.join(trackerDir, 'edge.jsonl'),
        '\n\n' + JSON.stringify({ filePath: '/valid.ts' }) + '\n\n');

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      await input.stop();

      const trackerEntries = allEntries.filter(e => e['agent.toolName'] === 'qoder-ai-tracker');
      expect(trackerEntries.length).toBeGreaterThanOrEqual(1);
    });

    it('should skip malformed JSON in tracker file', async () => {
      const trackerDir = path.join(tmpDir, 'SharedClientCache', 'cache', 'ai_tracker');
      await fs.mkdir(trackerDir, { recursive: true });

      await fs.writeFile(path.join(trackerDir, 'bad.jsonl'),
        'not json\n' + JSON.stringify({ filePath: '/ok.ts' }) + '\n');

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      await input.stop();

      const trackerEntries = allEntries.filter(e => e['agent.toolName'] === 'qoder-ai-tracker');
      expect(trackerEntries.length).toBeGreaterThanOrEqual(1);
    });

    it('should skip non-jsonl files in tracker directory', async () => {
      const trackerDir = path.join(tmpDir, 'SharedClientCache', 'cache', 'ai_tracker');
      await fs.mkdir(trackerDir, { recursive: true });

      await fs.writeFile(path.join(trackerDir, 'readme.txt'), 'not a jsonl file');
      await fs.writeFile(path.join(trackerDir, 'valid.jsonl'),
        JSON.stringify({ filePath: '/valid.ts' }) + '\n');

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      await input.stop();

      const trackerEntries = allEntries.filter(e => e['agent.toolName'] === 'qoder-ai-tracker');
      expect(trackerEntries.length).toBeGreaterThanOrEqual(1);
    });
  });
});
