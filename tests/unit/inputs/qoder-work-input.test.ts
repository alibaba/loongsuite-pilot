import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ClientType, ActionType } from '../../../src/types/index.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { QoderWorkInput } from '../../../src/inputs/qoder-work/qoder-work-input.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';

function getTodayDateString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

describe('QoderWorkInput', () => {
  let tmpDir: string;
  let stateStore: MockStateStore;
  let input: QoderWorkInput;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qw-test-'));
    stateStore = new MockStateStore();
    input = new QoderWorkInput({
      stateStore: stateStore as any,
      logDir: tmpDir,
      logPrefix: 'qoder-work',
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
      const logFile = path.join(tmpDir, `qoder-work-${today}.jsonl`);
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
      expect(allEntries[0]!['gen_ai.agent.type']).toBe(ClientType.QoderWork);
      expect(allEntries[0]!['agent.file_path']).toBe('/src/app.ts');
      await input.stop();
    });

    it('should process PostToolUse wrapped in data envelope', async () => {
      const today = getTodayDateString();
      const logFile = path.join(tmpDir, `qoder-work-${today}.jsonl`);
      const record = {
        hookEvent: 'PostToolUse',
        data: {
          hook_event_name: 'PostToolUse',
          tool_name: 'create_file',
          tool_input: { file_path: '/new.ts', content: 'export const x = 1;' },
          loongsuite_pilot_pre_file_exists: false,
          session_id: 'sess-2',
          timestamp: Date.now(),
        },
      };
      await fs.writeFile(logFile, JSON.stringify(record) + '\n');

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      expect(allEntries).toHaveLength(1);
      expect(allEntries[0]!['agent.action_type']).toBe(ActionType.Create);
      await input.stop();
    });

    it('should skip non-PostToolUse events', async () => {
      const today = getTodayDateString();
      const logFile = path.join(tmpDir, `qoder-work-${today}.jsonl`);
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

  describe('Create vs Edit classification', () => {
    it('should classify as Create when loongsuite_pilot_pre_file_exists = false', async () => {
      const today = getTodayDateString();
      const logFile = path.join(tmpDir, `qoder-work-${today}.jsonl`);
      const record = {
        event_type: 'PostToolUse',
        tool_name: 'create_file',
        tool_input: { file_path: '/new-file.ts', content: 'new' },
        loongsuite_pilot_pre_file_exists: false,
        session_id: 'sess-1',
        timestamp: Date.now(),
      };
      await fs.writeFile(logFile, JSON.stringify(record) + '\n');

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      expect(allEntries).toHaveLength(1);
      expect(allEntries[0]!['agent.action_type']).toBe(ActionType.Create);
      await input.stop();
    });

    it('should classify as Edit when loongsuite_pilot_pre_file_exists = true', async () => {
      const today = getTodayDateString();
      const logFile = path.join(tmpDir, `qoder-work-${today}.jsonl`);
      const record = {
        event_type: 'PostToolUse',
        tool_name: 'write_to_file',
        tool_input: { file_path: '/existing.ts', content: 'updated' },
        loongsuite_pilot_pre_file_exists: true,
        session_id: 'sess-1',
        timestamp: Date.now(),
      };
      await fs.writeFile(logFile, JSON.stringify(record) + '\n');

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      expect(allEntries).toHaveLength(1);
      expect(allEntries[0]!['agent.action_type']).toBe(ActionType.Edit);
      await input.stop();
    });
  });

  describe('records without file_path', () => {
    it('should skip events that have no file_path', async () => {
      const today = getTodayDateString();
      const logFile = path.join(tmpDir, `qoder-work-${today}.jsonl`);
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

  describe('transcript rows', () => {
    it('prefers canonical qoder-work hook records when present', async () => {
      const today = getTodayDateString();
      const logFile = path.join(tmpDir, `qoder-work-${today}.jsonl`);
      const record = {
        'event.id': 'canonical-work-1',
        'event.name': 'llm.response',
        time_unix_nano: '1777628163513000000',
        observed_time_unix_nano: '1777628163513000000',
        'user.id': 'u-work',
        'gen_ai.agent.type': ClientType.QoderWork,
        'gen_ai.session.id': 'sess-work',
        'gen_ai.output.messages': [{ type: 'text', content: 'hello work' }],
        'agent.source': 'qoder-transcript-hook',
      };
      await fs.writeFile(logFile, JSON.stringify(record) + '\n');

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      expect(allEntries).toHaveLength(1);
      expect(allEntries[0]).toMatchObject({
        'event.id': 'canonical-work-1',
        'event.name': 'llm.response',
        'user.id': 'u-work',
        'gen_ai.agent.type': ClientType.QoderWork,
        'gen_ai.session.id': 'sess-work',
        'gen_ai.output.messages': [{ type: 'text', content: 'hello work' }],
      });
      await input.stop();
    });

    it('keeps qoder-work as the agent type for user rows', async () => {
      const today = getTodayDateString();
      const logFile = path.join(tmpDir, `qoder-work-${today}.jsonl`);
      const record = {
        type: 'user',
        session_id: 'sess-1',
        user_id: 'u1',
        timestamp: Date.now(),
        message: {
          role: 'user',
          content: 'hello qoder work',
        },
      };
      await fs.writeFile(logFile, JSON.stringify(record) + '\n');

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      expect(allEntries).toHaveLength(1);
      expect(allEntries[0]!['gen_ai.agent.type']).toBe(ClientType.QoderWork);
      expect(allEntries[0]!['agent.type']).toBeUndefined();
      expect(allEntries[0]!['agent.type']).not.toBe('user');
      await input.stop();
    });
  });

  describe('content extraction', () => {
    it('should extract content from tool_input.content', async () => {
      const today = getTodayDateString();
      const logFile = path.join(tmpDir, `qoder-work-${today}.jsonl`);
      const record = {
        event_type: 'PostToolUse',
        tool_name: 'create_file',
        tool_input: { file_path: '/f.ts', content: 'const x = 42;' },
        loongsuite_pilot_pre_file_exists: false,
        session_id: 'sess-1',
        timestamp: Date.now(),
      };
      await fs.writeFile(logFile, JSON.stringify(record) + '\n');

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      expect(allEntries[0]!['agent.content']).toBe('const x = 42;');
      await input.stop();
    });

    it('should fall back to tool_input.new_string for content', async () => {
      const today = getTodayDateString();
      const logFile = path.join(tmpDir, `qoder-work-${today}.jsonl`);
      const record = {
        event_type: 'PostToolUse',
        tool_name: 'str_replace_editor',
        tool_input: { file_path: '/f.ts', new_string: 'replaced text' },
        session_id: 'sess-1',
        timestamp: Date.now(),
      };
      await fs.writeFile(logFile, JSON.stringify(record) + '\n');

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      expect(allEntries[0]!['agent.content']).toBe('replaced text');
      await input.stop();
    });
  });
});
