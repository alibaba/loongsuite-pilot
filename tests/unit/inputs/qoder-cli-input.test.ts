import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ClientType, ActionType } from '../../../src/types/index.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { QoderCliInput } from '../../../src/inputs/qoder-cli/qoder-cli-input.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';

function getTodayDateString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

describe('QoderCliInput', () => {
  let tmpDir: string;
  let stateStore: MockStateStore;
  let input: QoderCliInput;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qcli-test-'));
    stateStore = new MockStateStore();
    input = new QoderCliInput({
      stateStore: stateStore as any,
      logDir: tmpDir,
      logPrefix: 'qoder-cli',
      pollIntervalMs: 60_000,
    });
  });

  afterEach(async () => {
    if (input.running) await input.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('PostToolUse event filtering', () => {
    it('should process PostToolUse events', async () => {
      const today = getTodayDateString();
      const logFile = path.join(tmpDir, `qoder-cli-${today}.jsonl`);
      const record = {
        event_type: 'PostToolUse',
        tool_name: 'write_to_file',
        tool_input: { file_path: '/src/app.ts', content: 'hello' },
        session_id: 'sess-1',
        user_id: 'u1',
        timestamp: Date.now(),
      };
      await fs.writeFile(logFile, JSON.stringify(record) + '\n');

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      expect(allEntries).toHaveLength(1);
      expect(allEntries[0]!.agentType).toBe(ClientType.QoderCliHook);
      expect(allEntries[0]!.filePath).toBe('/src/app.ts');
      await input.stop();
    });

    it('should skip non-PostToolUse events', async () => {
      const today = getTodayDateString();
      const logFile = path.join(tmpDir, `qoder-cli-${today}.jsonl`);
      const records = [
        { event_type: 'PreToolUse', tool_name: 'read_file', tool_input: { file_path: '/a.ts' } },
        { event_type: 'failure', error: 'timeout' },
        { event_type: null },
      ];
      await fs.writeFile(logFile, records.map(r => JSON.stringify(r)).join('\n') + '\n');

      const entries: AgentActivityEntry[][] = [];
      input.on('entries', (e: AgentActivityEntry[]) => entries.push(e));

      await input.start();
      expect(entries).toHaveLength(0);
      await input.stop();
    });
  });

  describe('file create/edit action classification', () => {
    it('should classify as Create when file did not exist (aac_pre_file_exists = false)', async () => {
      const today = getTodayDateString();
      const logFile = path.join(tmpDir, `qoder-cli-${today}.jsonl`);
      const record = {
        event_type: 'PostToolUse',
        tool_name: 'create_file',
        tool_input: { file_path: '/new-file.ts', content: 'new' },
        aac_pre_file_exists: false,
        session_id: 'sess-1',
        timestamp: Date.now(),
      };
      await fs.writeFile(logFile, JSON.stringify(record) + '\n');

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      expect(allEntries).toHaveLength(1);
      expect(allEntries[0]!.actionType).toBe(ActionType.Create);
      await input.stop();
    });

    it('should classify as Edit when file already existed (aac_pre_file_exists = true)', async () => {
      const today = getTodayDateString();
      const logFile = path.join(tmpDir, `qoder-cli-${today}.jsonl`);
      const record = {
        event_type: 'PostToolUse',
        tool_name: 'write_to_file',
        tool_input: { file_path: '/existing.ts', content: 'updated' },
        aac_pre_file_exists: true,
        session_id: 'sess-1',
        timestamp: Date.now(),
      };
      await fs.writeFile(logFile, JSON.stringify(record) + '\n');

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      expect(allEntries).toHaveLength(1);
      expect(allEntries[0]!.actionType).toBe(ActionType.Edit);
      await input.stop();
    });
  });

  describe('events without file_path', () => {
    it('should skip events that have no file_path', async () => {
      const today = getTodayDateString();
      const logFile = path.join(tmpDir, `qoder-cli-${today}.jsonl`);
      const record = {
        event_type: 'PostToolUse',
        tool_name: 'bash',
        tool_input: { command: 'ls' },
        session_id: 'sess-1',
        timestamp: Date.now(),
      };
      await fs.writeFile(logFile, JSON.stringify(record) + '\n');

      const entries: AgentActivityEntry[][] = [];
      input.on('entries', (e: AgentActivityEntry[]) => entries.push(e));

      await input.start();
      expect(entries).toHaveLength(0);
      await input.stop();
    });
  });
});
