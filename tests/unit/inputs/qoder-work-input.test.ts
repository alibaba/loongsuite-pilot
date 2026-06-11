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
    async function writeAndDrain(record: unknown): Promise<AgentActivityEntry> {
      const today = getTodayDateString();
      const logFile = path.join(tmpDir, `qoder-work-${today}.jsonl`);
      await fs.writeFile(logFile, JSON.stringify(record) + '\n');
      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));
      await input.start();
      await input.stop();
      expect(allEntries).toHaveLength(1);
      return allEntries[0]!;
    }

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
        'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content: 'hello work' }] }],
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
        'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content: 'hello work' }] }],
      });
      await input.stop();
    });

    it('drops legacy agent.* noise fields for transcript rows', async () => {
      const entry = await writeAndDrain({
        type: 'user',
        session_id: 'sess-1',
        user_id: 'u1',
        cwd: '/tmp/ws',
        parentUuid: 'p-1',
        userType: 'external',
        timestamp: Date.now(),
        message: { role: 'user', content: 'hello qoder work' },
      });

      expect(entry['gen_ai.agent.type']).toBe(ClientType.QoderWork);
      // Fields that get rewritten by the gen_ai.* normalisation or never set
      // on text-only user rows. agent._c* are intentionally retained for
      // legacy dashboards — see qoder-work-input.ts back-compat block.
      for (const dropped of [
        'agent.type',
        'agent.role',
        'agent.content',
        'agent.model',
        'agent.stop_reason',
        'agent.file_path',
        'agent.action_type',
      ]) {
        expect(entry[dropped]).toBeUndefined();
      }
      // Legacy back-compat: text user rows still carry agent._ctype/_ctext.
      expect(entry['agent._ctype']).toBe('text');
      expect(entry['agent._ctext']).toBe('hello qoder work');
      expect(entry['agent.cwd']).toBe('/tmp/ws');
      expect(entry['agent.parent_uuid']).toBe('p-1');
      expect(entry['agent.user_type']).toBe('external');
      expect(entry['agent.row_type']).toBe('user');
    });

    it('maps user text into llm.request with gen_ai.input.messages_delta', async () => {
      const entry = await writeAndDrain({
        type: 'user',
        session_id: 'sess-u',
        timestamp: Date.now(),
        message: { role: 'user', content: '你好' },
      });

      expect(entry['event.name']).toBe('llm.request');
      expect(entry['gen_ai.input.messages_delta']).toEqual([
        { role: 'user', parts: [{ type: 'text', content: '你好' }] },
      ]);
      expect(entry['gen_ai.output.messages']).toBeUndefined();
    });

    it('maps assistant text into llm.response with gen_ai.output.messages and finish_reasons', async () => {
      const entry = await writeAndDrain({
        type: 'assistant',
        session_id: 'sess-a',
        timestamp: Date.now(),
        message: {
          role: 'assistant',
          id: 'msg-42',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: '我是 QoderWork' }],
        },
      });

      expect(entry['event.name']).toBe('llm.response');
      expect(entry['gen_ai.response.id']).toBe('msg-42');
      expect(entry['gen_ai.response.finish_reasons']).toEqual(['end_turn']);
      expect(entry['gen_ai.output.messages']).toEqual([
        {
          role: 'assistant',
          parts: [{ type: 'text', content: '我是 QoderWork' }],
          finish_reason: 'end_turn',
        },
      ]);
    });

    it('maps assistant thinking into reasoning part', async () => {
      const entry = await writeAndDrain({
        type: 'assistant',
        session_id: 'sess-t',
        timestamp: Date.now(),
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: '用户在问名字…' }],
        },
      });

      expect(entry['event.name']).toBe('llm.response');
      expect(entry['gen_ai.output.messages']).toEqual([
        { role: 'assistant', parts: [{ type: 'reasoning', content: '用户在问名字…' }] },
      ]);
    });

    it('maps tool_use content into tool.call with gen_ai.tool.*', async () => {
      const entry = await writeAndDrain({
        type: 'assistant',
        session_id: 'sess-tc',
        timestamp: Date.now(),
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'toolu_01',
            name: 'Bash',
            input: { command: 'ls' },
          }],
        },
      });

      expect(entry['event.name']).toBe('tool.call');
      expect(entry['gen_ai.tool.name']).toBe('Bash');
      expect(entry['gen_ai.tool.call.id']).toBe('toolu_01');
      expect(entry['gen_ai.tool.call.arguments']).toEqual({ command: 'ls' });
    });

    it('maps tool_result content into tool.result with gen_ai.tool.call.result', async () => {
      const entry = await writeAndDrain({
        type: 'user',
        session_id: 'sess-tr',
        timestamp: Date.now(),
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_01',
            content: 'file1\nfile2',
          }],
        },
      });

      expect(entry['event.name']).toBe('tool.result');
      expect(entry['gen_ai.tool.call.id']).toBe('toolu_01');
      expect(entry['gen_ai.tool.call.result']).toBe('file1\nfile2');
    });
  });

  describe('content extraction (PostToolUse)', () => {
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

  describe('QoderWork CN variant (parameterized)', () => {
    let cnTmpDir: string;
    let cnInput: QoderWorkInput;

    beforeEach(async () => {
      cnTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwcn-test-'));
      cnInput = new QoderWorkInput({
        stateStore: stateStore as any,
        agentType: ClientType.QoderWorkCN,
        logDir: cnTmpDir,
        logPrefix: 'qoder-work-cn',
        pollIntervalMs: 60_000,
      });
    });

    afterEach(async () => {
      if (cnInput.running) await cnInput.stop();
      await fs.rm(cnTmpDir, { recursive: true, force: true });
    });

    it('should have CN id and agentType', () => {
      expect(cnInput.id).toBe('qoder-work-cn-hook');
      expect(cnInput.agentType).toBe(ClientType.QoderWorkCN);
    });

    it('should emit entries with qoder-work-cn agent type', async () => {
      const today = getTodayDateString();
      const logFile = path.join(cnTmpDir, `qoder-work-cn-${today}.jsonl`);
      const record = {
        event_type: 'PostToolUse',
        tool_name: 'write_to_file',
        tool_input: { file_path: '/src/cn.ts', content: 'cn content' },
        session_id: 'sess-cn-1',
        user_id: 'cn-user',
        timestamp: Date.now(),
      };
      await fs.writeFile(logFile, JSON.stringify(record) + '\n');

      const allEntries: AgentActivityEntry[] = [];
      cnInput.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await cnInput.start();
      expect(allEntries).toHaveLength(1);
      expect(allEntries[0]!['gen_ai.agent.type']).toBe(ClientType.QoderWorkCN);
      await cnInput.stop();
    });
  });
});
