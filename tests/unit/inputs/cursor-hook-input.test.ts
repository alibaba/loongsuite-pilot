import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { ClientType } from '../../../src/types/index.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { CursorHookInput } from '../../../src/inputs/cursor-hook/cursor-hook-input.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';

const execFile = promisify(execFileCb);

function getTodayDateString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

describe('CursorHookInput', () => {
  let tmpDir: string;
  let stateStore: MockStateStore;
  let input: CursorHookInput;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-hook-input-test-'));
    stateStore = new MockStateStore();
    input = new CursorHookInput({
      stateStore: stateStore as any,
      logDir: tmpDir,
      logPrefix: 'cursor',
      pollIntervalMs: 60_000,
    });
    // Pre-set state to bypass first-run guard (offset = 0 means "already tracking this file")
    const today = getTodayDateString();
    stateStore.set('cursor-hook', { lastFile: `cursor-${today}.jsonl`, lastOffset: 0 });
  });

  afterEach(async () => {
    if (input.running) await input.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('processes canonical tool.call record', async () => {
    const today = getTodayDateString();
    const logFile = path.join(tmpDir, `cursor-${today}.jsonl`);
    const record = {
      'event.id': 'r-1',
      'event.name': 'tool.call',
      'gen_ai.agent.type': ClientType.Cursor,
      time_unix_nano: '1777628163513000000',
      observed_time_unix_nano: '1777628163513000000',
      'gen_ai.session.id': 'sess-1',
      'gen_ai.turn.id': 'turn-1',
      'gen_ai.request.model': 'gpt-5.5',
      'gen_ai.response.model': 'gpt-5.5',
      'gen_ai.tool.name': 'Shell',
      'gen_ai.tool.call.id': 'tool-1',
      'gen_ai.tool.call.arguments': { command: 'echo hello', cwd: '/workspace/project' },
      'agent.cursor.hook_event_name': 'preToolUse',
    };
    await fs.writeFile(logFile, `${JSON.stringify(record)}\n`);

    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    expect(entries).toHaveLength(1);
    expect(entries[0]!['gen_ai.agent.type']).toBe(ClientType.Cursor);
    expect(entries[0]!['event.name']).toBe('tool.call');
    expect(entries[0]!['gen_ai.session.id']).toBe('sess-1');
    expect(entries[0]!['gen_ai.turn.id']).toBe('turn-1');
    expect(entries[0]!['gen_ai.tool.name']).toBe('Shell');
    expect(entries[0]!['gen_ai.tool.call.id']).toBe('tool-1');
    expect(entries[0]!['gen_ai.tool.call.arguments']).toEqual({ command: 'echo hello', cwd: '/workspace/project' });
    expect(entries[0]!['gen_ai.request.model']).toBe('gpt-5.5');
  });

  it('preserves all canonical fields', async () => {
    const today = getTodayDateString();
    const logFile = path.join(tmpDir, `cursor-${today}.jsonl`);
    const record = {
      'event.id': 'canonical-1',
      'event.name': 'tool.call',
      time_unix_nano: '1777628163513000000',
      observed_time_unix_nano: '1777628163513000000',
      'user.id': 'hook-user',
      'gen_ai.agent.type': ClientType.Cursor,
      'gen_ai.provider.name': 'openai',
      'gen_ai.session.id': 'sess-canonical',
      'gen_ai.tool.name': 'Shell',
      'gen_ai.tool.call.id': 'tool-canonical',
      'gen_ai.tool.call.arguments': { command: 'pwd' },
      'agent.cursor.hook_event_name': 'preToolUse',
    };
    await fs.writeFile(logFile, `${JSON.stringify(record)}\n`);

    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      'event.id': 'canonical-1',
      'event.name': 'tool.call',
      'user.id': 'hook-user',
      'gen_ai.agent.type': ClientType.Cursor,
      'gen_ai.provider.name': 'openai',
      'gen_ai.session.id': 'sess-canonical',
      'gen_ai.tool.name': 'Shell',
      'gen_ai.tool.call.id': 'tool-canonical',
      'gen_ai.tool.call.arguments': { command: 'pwd' },
      'agent.cursor.hook_event_name': 'preToolUse',
    });
  });

  it('processes canonical tool.result record', async () => {
    const today = getTodayDateString();
    const logFile = path.join(tmpDir, `cursor-${today}.jsonl`);
    const record = {
      'event.id': 'r-2',
      'event.name': 'tool.result',
      'gen_ai.agent.type': ClientType.Cursor,
      time_unix_nano: '1777628163513000000',
      observed_time_unix_nano: '1777628163513000000',
      'gen_ai.session.id': 'sess-from-raw',
      'gen_ai.request.model': 'composer-2.5',
      'gen_ai.response.model': 'composer-2.5',
      'gen_ai.tool.call.result': { output: 'ok', exitCode: 0 },
      'gen_ai.tool.call.duration': 12.5,
      'agent.cursor.hook_event_name': 'postToolUse',
    };
    await fs.writeFile(logFile, `${JSON.stringify(record)}\n`);

    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    expect(entries).toHaveLength(1);
    expect(entries[0]!['event.name']).toBe('tool.result');
    expect(entries[0]!['gen_ai.session.id']).toBe('sess-from-raw');
    expect(entries[0]!['gen_ai.tool.call.result']).toEqual({ output: 'ok', exitCode: 0 });
    expect(entries[0]!['gen_ai.tool.call.duration']).toBe(12.5);
  });

  it('processes canonical llm.response record', async () => {
    const today = getTodayDateString();
    const logFile = path.join(tmpDir, `cursor-${today}.jsonl`);
    const record = {
      'event.id': 'r-3',
      'event.name': 'llm.response',
      'gen_ai.agent.type': ClientType.Cursor,
      time_unix_nano: '1777628163513000000',
      observed_time_unix_nano: '1777628163513000000',
      'gen_ai.session.id': 's-thought',
      'gen_ai.request.model': 'gpt-5.5',
      'gen_ai.response.model': 'gpt-5.5',
      'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'reasoning', content: 'thinking...' }] }],
      'agent.cursor.hook_event_name': 'afterAgentThought',
    };
    await fs.writeFile(logFile, `${JSON.stringify(record)}\n`);

    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    expect(entries).toHaveLength(1);
    expect(entries[0]!['event.name']).toBe('llm.response');
    expect(entries[0]!['gen_ai.output.messages']).toEqual([{ role: 'assistant', parts: [{ type: 'reasoning', content: 'thinking...' }] }]);
  });

  it('processes canonical other record with usage fields', async () => {
    const today = getTodayDateString();
    const logFile = path.join(tmpDir, `cursor-${today}.jsonl`);
    const record = {
      'event.id': 'r-4',
      'event.name': 'other',
      'gen_ai.agent.type': ClientType.Cursor,
      time_unix_nano: '1777628163513000000',
      observed_time_unix_nano: '1777628163513000000',
      'gen_ai.session.id': 's-prompt',
      'gen_ai.turn.id': 'turn-prompt',
      'gen_ai.request.model': 'gpt-5.5',
      'gen_ai.response.model': 'gpt-5.5',
      'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: 'please inspect this' }] }],
      'gen_ai.usage.input_tokens': 10,
      'gen_ai.usage.output_tokens': 4,
      'gen_ai.usage.cache_read.input_tokens': 2,
      'gen_ai.usage.cache_creation.input_tokens': 1,
      'gen_ai.usage.total_tokens': 14,
      'gen_ai.usage.input_cost': 0.1,
      'gen_ai.usage.output_cost': 0.2,
      'agent.cursor.hook_event_name': 'beforeSubmitPrompt',
      'agent.cursor.user_email': 'cursor@example.com',
      'agent.cursor.transcript_path': '/tmp/transcript.jsonl',
    };
    await fs.writeFile(logFile, `${JSON.stringify(record)}\n`);

    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    expect(entries).toHaveLength(1);
    expect(entries[0]!['event.name']).toBe('other');
    expect(entries[0]!['gen_ai.input.messages_delta']).toEqual([{ role: 'user', parts: [{ type: 'text', content: 'please inspect this' }] }]);
    expect(entries[0]!['gen_ai.usage.input_tokens']).toBe(10);
    expect(entries[0]!['gen_ai.usage.output_tokens']).toBe(4);
    expect(entries[0]!['gen_ai.usage.total_tokens']).toBe(14);
    expect(entries[0]!['gen_ai.usage.input_cost']).toBe(0.1);
    expect(entries[0]!['gen_ai.usage.output_cost']).toBe(0.2);
    expect(entries[0]!['agent.cursor.user_email']).toBe('cursor@example.com');
    expect(entries[0]!['agent.cursor.transcript_path']).toBe('/tmp/transcript.jsonl');
  });

  it('processes canonical tool.result with error fields', async () => {
    const today = getTodayDateString();
    const logFile = path.join(tmpDir, `cursor-${today}.jsonl`);
    const record = {
      'event.id': 'r-5',
      'event.name': 'tool.result',
      'gen_ai.agent.type': ClientType.Cursor,
      time_unix_nano: '1777628163513000000',
      observed_time_unix_nano: '1777628163513000000',
      'gen_ai.session.id': 's-fail',
      'gen_ai.tool.name': 'Shell',
      'gen_ai.tool.call.id': 'tool-fail',
      'error.type': 'tool_use_failure',
      'error.message': 'tool failed',
      'agent.cursor.hook_event_name': 'postToolUseFailure',
    };
    await fs.writeFile(logFile, `${JSON.stringify(record)}\n`);

    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    expect(entries).toHaveLength(1);
    expect(entries[0]!['event.name']).toBe('tool.result');
    expect(entries[0]!['error.type']).toBe('tool_use_failure');
    expect(entries[0]!['error.message']).toBe('tool failed');
  });

  it('returns null for non-canonical records (no event.name or gen_ai.agent.type)', async () => {
    const today = getTodayDateString();
    const logFile = path.join(tmpDir, `cursor-${today}.jsonl`);
    // Old-format record without event.name and gen_ai.agent.type
    const record = {
      'event.id': 'r-6',
      observed_time_unix_nano: '1777628163513000000',
      time_unix_nano: '1777628163513000000',
      hook_event_name: 'sessionStart',
      session_id: 's-message',
      message: 'normal lifecycle message',
    };
    await fs.writeFile(logFile, `${JSON.stringify(record)}\n`);

    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    // Non-canonical records are now skipped (return null)
    expect(entries).toHaveLength(0);
  });

  it('strips token/cost fields from canonical stop records', async () => {
    const today = getTodayDateString();
    const logFile = path.join(tmpDir, `cursor-${today}.jsonl`);
    const record = {
      'event.id': 'r-stop-canonical',
      'event.name': 'other',
      'gen_ai.agent.type': 'cursor',
      'gen_ai.session.id': 'sess-stop-c',
      'gen_ai.turn.id': 'turn-stop-c',
      'gen_ai.request.model': 'gpt-5.5',
      'gen_ai.response.model': 'gpt-5.5',
      'gen_ai.usage.input_tokens': 15809,
      'gen_ai.usage.output_tokens': 141,
      'gen_ai.usage.total_tokens': 15950,
      'agent.cursor.hook_event_name': 'stop',
      'agent.cursor.status': 'completed',
      'agent.cursor.loop_count': 0,
      observed_time_unix_nano: '1777628163513000000',
      time_unix_nano: '1777628163513000000',
    };
    await fs.writeFile(logFile, `${JSON.stringify(record)}\n`);

    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    expect(entries).toHaveLength(1);
    expect(entries[0]!['event.name']).toBe('other');
    expect(entries[0]!['gen_ai.session.id']).toBe('sess-stop-c');
    expect(entries[0]!['gen_ai.usage.input_tokens']).toBeUndefined();
    expect(entries[0]!['gen_ai.usage.output_tokens']).toBeUndefined();
    expect(entries[0]!['gen_ai.usage.total_tokens']).toBeUndefined();
  });

  it('preserves token fields on canonical afterAgentResponse records', async () => {
    const today = getTodayDateString();
    const logFile = path.join(tmpDir, `cursor-${today}.jsonl`);
    const record = {
      'event.id': 'r-resp',
      'event.name': 'llm.response',
      'gen_ai.agent.type': ClientType.Cursor,
      time_unix_nano: '1777628163513000000',
      observed_time_unix_nano: '1777628163513000000',
      'gen_ai.session.id': 'sess-resp',
      'gen_ai.turn.id': 'turn-resp',
      'gen_ai.request.model': 'gpt-5.5',
      'gen_ai.response.model': 'gpt-5.5',
      'gen_ai.usage.input_tokens': 15809,
      'gen_ai.usage.output_tokens': 141,
      'gen_ai.usage.cache_read.input_tokens': 7424,
      'gen_ai.usage.total_tokens': 15950,
      'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content: 'hello world' }] }],
      'agent.cursor.hook_event_name': 'afterAgentResponse',
    };
    await fs.writeFile(logFile, `${JSON.stringify(record)}\n`);

    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    expect(entries).toHaveLength(1);
    expect(entries[0]!['event.name']).toBe('llm.response');
    expect(entries[0]!['gen_ai.usage.input_tokens']).toBe(15809);
    expect(entries[0]!['gen_ai.usage.output_tokens']).toBe(141);
    expect(entries[0]!['gen_ai.usage.cache_read.input_tokens']).toBe(7424);
    expect(entries[0]!['gen_ai.usage.total_tokens']).toBe(15950);
  });

  it('first-run guard skips existing history on fresh start', async () => {
    // Reset state to simulate fresh daemon start
    stateStore.set('cursor-hook', {});

    const today = getTodayDateString();
    const logFile = path.join(tmpDir, `cursor-${today}.jsonl`);

    // Write existing history records
    const oldRecord = {
      'event.id': 'old-1',
      'event.name': 'tool.call',
      'gen_ai.agent.type': ClientType.Cursor,
      time_unix_nano: '1777628163513000000',
      observed_time_unix_nano: '1777628163513000000',
      'gen_ai.session.id': 'old-sess',
      'gen_ai.tool.name': 'Shell',
      'gen_ai.tool.call.id': 'old-tool',
    };
    await fs.writeFile(logFile, `${JSON.stringify(oldRecord)}\n`);

    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    // Old records should be skipped by first-run guard
    expect(entries).toHaveLength(0);
  });

  it('first-run guard allows new records appended after startup', async () => {
    // Stop the default input and create one with a short poll interval
    await input.stop();
    const fastInput = new CursorHookInput({
      stateStore: stateStore as any,
      logDir: tmpDir,
      logPrefix: 'cursor',
      pollIntervalMs: 50,
    });

    // Reset state to simulate fresh daemon start
    stateStore.set('cursor-hook', {});

    const today = getTodayDateString();
    const logFile = path.join(tmpDir, `cursor-${today}.jsonl`);

    // Write existing history
    const oldRecord = {
      'event.id': 'old-1',
      'event.name': 'tool.call',
      'gen_ai.agent.type': ClientType.Cursor,
      time_unix_nano: '1777628163513000000',
      observed_time_unix_nano: '1777628163513000000',
      'gen_ai.session.id': 'old-sess',
      'gen_ai.tool.name': 'Shell',
      'gen_ai.tool.call.id': 'old-tool',
    };
    await fs.writeFile(logFile, `${JSON.stringify(oldRecord)}\n`);

    const entries: AgentActivityEntry[] = [];
    fastInput.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await fastInput.start();

    // Append a new record after startup
    const newRecord = {
      'event.id': 'new-1',
      'event.name': 'tool.call',
      'gen_ai.agent.type': ClientType.Cursor,
      time_unix_nano: '1777628163514000000',
      observed_time_unix_nano: '1777628163514000000',
      'gen_ai.session.id': 'new-sess',
      'gen_ai.tool.name': 'Read',
      'gen_ai.tool.call.id': 'new-tool',
    };
    await fs.appendFile(logFile, `${JSON.stringify(newRecord)}\n`);

    // Wait for a poll cycle (50ms interval + buffer)
    await new Promise(resolve => setTimeout(resolve, 150));
    await fastInput.stop();

    // Only the new record should be processed
    expect(entries).toHaveLength(1);
    expect(entries[0]!['event.id']).toBe('new-1');
    expect(entries[0]!['gen_ai.session.id']).toBe('new-sess');
  });

  it('date rollover: reads today records when lastFile points to yesterday', async () => {
    // Simulate daemon running since yesterday — state has yesterday's file
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
    stateStore.set('cursor-hook', { lastFile: `cursor-${yesterdayStr}.jsonl`, lastOffset: 500 });

    const today = getTodayDateString();
    const logFile = path.join(tmpDir, `cursor-${today}.jsonl`);

    // Write today's records
    const record = {
      'event.id': 'today-1',
      'event.name': 'tool.call',
      'gen_ai.agent.type': ClientType.Cursor,
      time_unix_nano: '1777628163513000000',
      observed_time_unix_nano: '1777628163513000000',
      'gen_ai.session.id': 'today-sess',
      'gen_ai.tool.name': 'Shell',
      'gen_ai.tool.call.id': 'today-tool',
      'gen_ai.tool.call.arguments': { command: 'date' },
      'agent.cursor.hook_event_name': 'preToolUse',
    };
    await fs.writeFile(logFile, `${JSON.stringify(record)}\n`);

    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    // Today's records should be read (base class resets offset to 0 for new file)
    expect(entries).toHaveLength(1);
    expect(entries[0]!['event.id']).toBe('today-1');
    expect(entries[0]!['gen_ai.session.id']).toBe('today-sess');
  });

  it('first-run guard does not re-fire when file did not exist initially', async () => {
    // Stop the default input and create one with a short poll interval
    await input.stop();
    const fastInput = new CursorHookInput({
      stateStore: stateStore as any,
      logDir: tmpDir,
      logPrefix: 'cursor',
      pollIntervalMs: 50,
    });

    // Reset state to simulate fresh daemon start
    stateStore.set('cursor-hook', {});

    // Do NOT create the log file — simulate daemon starting before Cursor writes
    const today = getTodayDateString();
    const logFile = path.join(tmpDir, `cursor-${today}.jsonl`);

    const entries: AgentActivityEntry[] = [];
    fastInput.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await fastInput.start();

    // After first poll (guard fires, file doesn't exist, writes lastOffset=0),
    // write a new record.
    const record = {
      'event.id': 'first-after-start',
      'event.name': 'tool.call',
      'gen_ai.agent.type': ClientType.Cursor,
      time_unix_nano: '1777628163513000000',
      observed_time_unix_nano: '1777628163513000000',
      'gen_ai.session.id': 'sess-1',
      'gen_ai.tool.name': 'Shell',
      'gen_ai.tool.call.id': 'tool-1',
      'gen_ai.tool.call.arguments': { command: 'echo hi' },
      'agent.cursor.hook_event_name': 'preToolUse',
    };
    await fs.writeFile(logFile, `${JSON.stringify(record)}\n`);

    // Wait for at least one more poll cycle
    await new Promise(r => setTimeout(r, 150));

    await fastInput.stop();

    // The record should be collected — guard must not re-fire and skip it
    expect(entries).toHaveLength(1);
    expect(entries[0]!['event.id']).toBe('first-after-start');
  });
});
