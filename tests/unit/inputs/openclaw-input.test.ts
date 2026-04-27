import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ClientType, ActionType } from '../../../src/types/index.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { OpenclawInput } from '../../../src/inputs/openclaw/openclaw-input.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';

describe('OpenclawInput', () => {
  let tmpDir: string;
  let stateStore: MockStateStore;
  let input: OpenclawInput;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-test-'));
    stateStore = new MockStateStore();
    input = new OpenclawInput({
      stateStore: stateStore as any,
      sessionDir: tmpDir,
      filePattern: 'session-*.jsonl',
      pollIntervalMs: 60_000,
    });
  });

  afterEach(async () => {
    if (input.running) await input.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('session_meta context update', () => {
    it('should capture session_meta and use it for subsequent tool_call entries', async () => {
      const file = path.join(tmpDir, 'session-abc.jsonl');
      const lines = [
        { type: 'session_meta', session_id: 'oc-sess-1', model: 'claude-3', cwd: '/proj' },
        { type: 'tool_call', tool_name: 'write_file', file_path: '/proj/main.ts', content: 'hi', timestamp: Date.now() },
      ];
      await fs.writeFile(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      // session_meta returns null, tool_call produces an entry
      expect(allEntries).toHaveLength(1);
      expect(allEntries[0]!.agentType).toBe(ClientType.Openclaw);
      expect(allEntries[0]!.sessionId).toBe('oc-sess-1');
      expect(allEntries[0]!.extra?.model).toBe('claude-3');
      await input.stop();
    });
  });

  describe('tool_call file operation filtering', () => {
    it('should process file-modifying tool_calls', async () => {
      const file = path.join(tmpDir, 'session-def.jsonl');
      const lines = [
        { type: 'tool_call', tool_name: 'write_file', file_path: '/a.ts', timestamp: Date.now() },
        { type: 'tool_call', tool_name: 'edit_file', file_path: '/b.ts', timestamp: Date.now() },
        { type: 'tool_call', tool_name: 'create_file', file_path: '/c.ts', timestamp: Date.now() },
        { type: 'tool_call', tool_name: 'delete_file', file_path: '/d.ts', timestamp: Date.now() },
      ];
      await fs.writeFile(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      expect(allEntries).toHaveLength(4);
      await input.stop();
    });

    it('should skip non-file tool_calls', async () => {
      const file = path.join(tmpDir, 'session-ghi.jsonl');
      const lines = [
        { type: 'tool_call', tool_name: 'bash', file_path: '/a.ts', timestamp: Date.now() },
        { type: 'tool_call', tool_name: 'search_web', file_path: '/a.ts', timestamp: Date.now() },
        { type: 'tool_call', tool_name: 'unknown_tool', file_path: '/a.ts', timestamp: Date.now() },
      ];
      await fs.writeFile(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');

      const entries: AgentActivityEntry[][] = [];
      input.on('entries', (e: AgentActivityEntry[]) => entries.push(e));

      await input.start();
      expect(entries).toHaveLength(0);
      await input.stop();
    });

    it('should skip tool_calls without file_path', async () => {
      const file = path.join(tmpDir, 'session-jkl.jsonl');
      const lines = [
        { type: 'tool_call', tool_name: 'write_file', timestamp: Date.now() },
      ];
      await fs.writeFile(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');

      const entries: AgentActivityEntry[][] = [];
      input.on('entries', (e: AgentActivityEntry[]) => entries.push(e));

      await input.start();
      expect(entries).toHaveLength(0);
      await input.stop();
    });
  });

  describe('non-tool_call events', () => {
    it('should skip assistant/user/summary events', async () => {
      const file = path.join(tmpDir, 'session-mno.jsonl');
      const lines = [
        { type: 'assistant', content: 'hello' },
        { type: 'user', content: 'hi' },
        { type: 'summary', data: {} },
      ];
      await fs.writeFile(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');

      const entries: AgentActivityEntry[][] = [];
      input.on('entries', (e: AgentActivityEntry[]) => entries.push(e));

      await input.start();
      expect(entries).toHaveLength(0);
      await input.stop();
    });
  });

  describe('action type classification', () => {
    it('should classify create_file as Create', async () => {
      const file = path.join(tmpDir, 'session-act.jsonl');
      await fs.writeFile(file, JSON.stringify({
        type: 'tool_call', tool_name: 'create_file', file_path: '/new.ts', timestamp: Date.now(),
      }) + '\n');

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      expect(allEntries[0]!.actionType).toBe(ActionType.Create);
      await input.stop();
    });

    it('should classify delete_file as Delete', async () => {
      const file = path.join(tmpDir, 'session-del.jsonl');
      await fs.writeFile(file, JSON.stringify({
        type: 'tool_call', tool_name: 'delete_file', file_path: '/old.ts', timestamp: Date.now(),
      }) + '\n');

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      expect(allEntries[0]!.actionType).toBe(ActionType.Delete);
      await input.stop();
    });

    it('should classify edit_file as Edit', async () => {
      const file = path.join(tmpDir, 'session-edt.jsonl');
      await fs.writeFile(file, JSON.stringify({
        type: 'tool_call', tool_name: 'edit_file', file_path: '/mod.ts', timestamp: Date.now(),
      }) + '\n');

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      expect(allEntries[0]!.actionType).toBe(ActionType.Edit);
      await input.stop();
    });
  });

  describe('session file discovery', () => {
    it('should discover session files in subdirectories', async () => {
      const subDir = path.join(tmpDir, 'sub-project');
      await fs.mkdir(subDir, { recursive: true });
      const file = path.join(subDir, 'session-sub.jsonl');
      await fs.writeFile(file, JSON.stringify({
        type: 'tool_call', tool_name: 'write_file', file_path: '/sub.ts', timestamp: Date.now(),
      }) + '\n');

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      expect(allEntries).toHaveLength(1);
      await input.stop();
    });
  });
});
