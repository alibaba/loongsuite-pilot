import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { ClientType, ActionType } from '../../src/types/index.js';
import type { AgentActivityEntry } from '../../src/types/index.js';
import { QoderCliInput } from '../../src/inputs/qoder-cli/qoder-cli-input.js';
import { CursorHookInput } from '../../src/inputs/cursor-hook/cursor-hook-input.js';
import { StateStore } from '../../src/checkpoints/state-store.js';
import { AgentActivityEntrySchema } from '../contract/agent-activity-schema.js';

function getTodayDateString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function runCursorHook(input: string, env: Record<string, string>) {
  return spawnSync('bash', [path.resolve(process.cwd(), 'assets/hooks/cursor-aac-hook.sh')], {
    input,
    env: { ...process.env, ...env },
    encoding: 'utf-8',
  });
}

describe('Hook JSONL integration flow', () => {
  let tmpDir: string;
  let stateStore: StateStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-integ-'));
    stateStore = new StateStore(path.join(tmpDir, 'state.json'));
    await stateStore.load();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should perform complete read → normalize → offset persist flow', async () => {
    const logDir = path.join(tmpDir, 'logs');
    await fs.mkdir(logDir, { recursive: true });

    const today = getTodayDateString();
    const logFile = path.join(logDir, `qoder-cli-${today}.jsonl`);

    const records = [
      {
        event_type: 'PostToolUse',
        tool_name: 'create_file',
        tool_input: { file_path: '/proj/new.ts', content: 'export const x = 1;' },
        aac_pre_file_exists: false,
        session_id: 'integ-sess-1',
        user_id: 'integ-user',
        timestamp: Date.now(),
      },
      {
        event_type: 'PostToolUse',
        tool_name: 'write_to_file',
        tool_input: { file_path: '/proj/existing.ts', content: 'updated' },
        aac_pre_file_exists: true,
        session_id: 'integ-sess-1',
        user_id: 'integ-user',
        timestamp: Date.now(),
      },
    ];
    await fs.writeFile(logFile, records.map(r => JSON.stringify(r)).join('\n') + '\n');

    const input = new QoderCliInput({
      stateStore: stateStore as any,
      logDir,
      logPrefix: 'qoder-cli',
      pollIntervalMs: 60_000,
    });

    const allEntries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

    await input.start();
    await input.stop();

    // Verify entries are normalized correctly
    expect(allEntries).toHaveLength(2);
    expect(allEntries[0]!.actionType).toBe(ActionType.Create);
    expect(allEntries[1]!.actionType).toBe(ActionType.Edit);

    // Verify all entries pass schema validation
    for (const entry of allEntries) {
      const result = AgentActivityEntrySchema.safeParse(entry);
      expect(result.success, `Entry should pass schema: ${JSON.stringify(entry)}`).toBe(true);
    }

    // Verify offset was persisted
    await stateStore.save();
    const offset = stateStore.getOffset('qoder-cli-hook');
    expect(offset).toBeGreaterThan(0);

    // Verify re-reading with same state yields no new entries
    const input2 = new QoderCliInput({
      stateStore: stateStore as any,
      logDir,
      logPrefix: 'qoder-cli',
      pollIntervalMs: 60_000,
    });

    const newEntries: AgentActivityEntry[] = [];
    input2.on('entries', (e: AgentActivityEntry[]) => newEntries.push(...e));

    await input2.start();
    await input2.stop();
    expect(newEntries).toHaveLength(0);
  });

  it('should handle incremental appends correctly', async () => {
    const logDir = path.join(tmpDir, 'logs2');
    await fs.mkdir(logDir, { recursive: true });

    const today = getTodayDateString();
    const logFile = path.join(logDir, `qoder-cli-${today}.jsonl`);

    // First batch
    await fs.writeFile(logFile, JSON.stringify({
      event_type: 'PostToolUse',
      tool_name: 'write_to_file',
      tool_input: { file_path: '/batch1.ts', content: 'a' },
      session_id: 's1',
      timestamp: Date.now(),
    }) + '\n');

    const input = new QoderCliInput({
      stateStore: stateStore as any,
      logDir: logDir,
      logPrefix: 'qoder-cli',
      pollIntervalMs: 60_000,
    });

    const allEntries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

    await input.start();
    expect(allEntries).toHaveLength(1);

    // Append second batch
    await fs.appendFile(logFile, JSON.stringify({
      event_type: 'PostToolUse',
      tool_name: 'write_to_file',
      tool_input: { file_path: '/batch2.ts', content: 'b' },
      session_id: 's2',
      timestamp: Date.now(),
    }) + '\n');

    // Manually trigger second collect by calling start on a new instance with same state
    await input.stop();
    await stateStore.save();

    const input2 = new QoderCliInput({
      stateStore: stateStore as any,
      logDir: logDir,
      logPrefix: 'qoder-cli',
      pollIntervalMs: 60_000,
    });

    const newEntries: AgentActivityEntry[] = [];
    input2.on('entries', (e: AgentActivityEntry[]) => newEntries.push(...e));

    await input2.start();
    await input2.stop();

    expect(newEntries).toHaveLength(1);
    expect(newEntries[0]!.filePath).toBe('/batch2.ts');
  });
});

describe('Cursor hook script integration flow', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-hook-integ-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should write normalized record for valid payload', async () => {
    const result = runCursorHook(JSON.stringify({
      hook_event_name: 'postToolUse',
      session_id: 'sess-1',
      generation_id: 'turn-1',
      model: 'gpt-test',
      tool_name: 'Shell',
      tool_input: { command: 'pwd' },
      tool_output: '{"ok":true}',
      cursor_version: '1.0.0',
    }), { AAC_DATA_DIR: tmpDir });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('{}');

    const logFile = path.join(tmpDir, 'logs', 'cursor-hook', 'history', `cursor-${getTodayDateString()}.jsonl`);
    const lines = (await fs.readFile(logFile, 'utf-8')).trim().split('\n');
    expect(lines).toHaveLength(1);

    const record = JSON.parse(lines[0]!);
    expect(record.clientType).toBe('CursorHook');
    expect(record.hookEvent).toBe('postToolUse');
    expect(record.data['gen_ai.session_id']).toBe('sess-1');
    expect(record.data['gen_ai.request_model']).toBe('gpt-test');
    expect(record.data['gen_ai.tool_name']).toBe('Shell');
    expect(record.data.session_id).toBeUndefined();
  });

  it('should append records for multiple invocations on same day', async () => {
    const env = { AAC_DATA_DIR: tmpDir };

    const first = runCursorHook(JSON.stringify({ hook_event_name: 'afterAgentResponse', text: 'a1' }), env);
    const second = runCursorHook(JSON.stringify({ hook_event_name: 'afterAgentThought', text: 't1' }), env);
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);

    const logFile = path.join(tmpDir, 'logs', 'cursor-hook', 'history', `cursor-${getTodayDateString()}.jsonl`);
    const lines = (await fs.readFile(logFile, 'utf-8')).trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('should infer mapping role and parse tool fields', async () => {
    const result = runCursorHook(JSON.stringify({
      hook_event_name: 'beforeMCPExecution',
      model: 'm-1',
      tool_name: 'search',
      tool_input: '{"query":"abc"}',
      result_json: '{"items":[1]}',
      conversation_id: 'conv-1',
    }), { AAC_DATA_DIR: tmpDir });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('{}');

    const logFile = path.join(tmpDir, 'logs', 'cursor-hook', 'history', `cursor-${getTodayDateString()}.jsonl`);
    const lines = (await fs.readFile(logFile, 'utf-8')).trim().split('\n');
    const record = JSON.parse(lines.at(-1)!);
    expect(record.data['gen_ai.role']).toBe('user');
    expect(record.data['gen_ai.tool_arguments']).toEqual({ query: 'abc' });
    expect(record.data['gen_ai.tool_results']).toEqual({ items: [1] });
    expect(record.data['gen_ai.session_id']).toBe('conv-1');
  });

  it('should keep fail-open behavior for invalid json payload', async () => {
    const result = runCursorHook('not-json', { AAC_DATA_DIR: tmpDir });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('{}');

    const logFile = path.join(tmpDir, 'logs', 'cursor-hook', 'history', `cursor-${getTodayDateString()}.jsonl`);
    await expect(fs.access(logFile)).rejects.toBeTruthy();
  });

  it('should keep fail-open behavior when log path is not writable', async () => {
    const badDataDir = path.join(tmpDir, 'not-a-dir');
    await fs.writeFile(badDataDir, 'x');

    const result = runCursorHook(JSON.stringify({ hook_event_name: 'postToolUse', text: 'hello' }), {
      AAC_DATA_DIR: badDataDir,
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('{}');
  });

  it('should cover key event families without missing records', async () => {
    const events = [
      'preToolUse',
      'afterShellExecution',
      'afterMCPExecution',
      'beforeReadFile',
      'sessionStart',
      'subagentStop',
      'beforeTabFileRead',
      'afterTabFileEdit',
    ];

    for (const eventName of events) {
      const result = runCursorHook(JSON.stringify({ hook_event_name: eventName, text: `evt:${eventName}` }), {
        AAC_DATA_DIR: tmpDir,
      });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('{}');
    }

    const logFile = path.join(tmpDir, 'logs', 'cursor-hook', 'history', `cursor-${getTodayDateString()}.jsonl`);
    const lines = (await fs.readFile(logFile, 'utf-8')).trim().split('\n');
    const emitted = lines.map(line => JSON.parse(line).hookEvent);
    for (const eventName of events) {
      expect(emitted).toContain(eventName);
    }
  });

  it('should be consumable by CursorHookInput and emit normalized entries', async () => {
    const result = runCursorHook(JSON.stringify({
      hook_event_name: 'beforeReadFile',
      session_id: 'sess-integ-cursor',
      file_path: '/project/a.ts',
      text: 'preview',
    }), { AAC_DATA_DIR: tmpDir });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('{}');

    const stateStore = new StateStore(path.join(tmpDir, 'state-cursor.json'));
    await stateStore.load();

    const input = new CursorHookInput({
      stateStore: stateStore as any,
      logDir: path.join(tmpDir, 'logs', 'cursor-hook', 'history'),
      logPrefix: 'cursor',
      pollIntervalMs: 60_000,
    });
    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    expect(entries).toHaveLength(1);
    expect(entries[0]!.agentType).toBe(ClientType.CursorHook);
    expect(entries[0]!.actionType).toBe(ActionType.Read);
    expect(entries[0]!.sessionId).toBe('sess-integ-cursor');
    expect(entries[0]!.filePath).toBe('/project/a.ts');
  });
});
