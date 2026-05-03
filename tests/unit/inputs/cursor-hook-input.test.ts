import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ClientType } from '../../../src/types/index.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { CursorHookInput } from '../../../src/inputs/cursor-hook/cursor-hook-input.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';

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
  });

  afterEach(async () => {
    if (input.running) await input.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('maps raw preToolUse hook record to tool.call event_t fields', async () => {
    const today = getTodayDateString();
    const logFile = path.join(tmpDir, `cursor-${today}.jsonl`);
    const record = {
      'event.id': 'r-1',
      observed_time_unix_nano: '1777628163513000000',
      time_unix_nano: '1777628163513000000',
      hook_event_name: 'preToolUse',
      conversation_id: 'sess-1',
      generation_id: 'turn-1',
      model: 'gpt-5.5',
      tool_name: 'Shell',
      tool_use_id: 'tool-1',
      tool_input: {
        command: 'echo hello',
        cwd: '/workspace',
      },
    };
    await fs.writeFile(logFile, `${JSON.stringify(record)}\n`);

    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    expect(entries).toHaveLength(1);
    expect(entries[0]!['agent.type']).toBe(ClientType.Cursor);
    expect(entries[0]!['event.name']).toBe('tool.call');
    expect(entries[0]!['session.id']).toBe('sess-1');
    expect(entries[0]!['turn.id']).toBe('turn-1');
    expect(entries[0]!['tool.name']).toBe('Shell');
    expect(entries[0]!['tool.call.id']).toBe('tool-1');
    expect(entries[0]!['tool.arguments']).toEqual({ command: 'echo hello', cwd: '/workspace' });
    expect(entries[0]!['request.model']).toBe('gpt-5.5');
    expect(entries[0]!['response.model']).toBe('gpt-5.5');
  });

  it('maps raw postToolUse hook record to tool.result event_t fields', async () => {
    const today = getTodayDateString();
    const logFile = path.join(tmpDir, `cursor-${today}.jsonl`);
    const record = {
      'event.id': 'r-2',
      observed_time_unix_nano: '1777628163513000000',
      time_unix_nano: '1777628163513000000',
      hook_event_name: 'postToolUse',
      session_id: 'sess-from-raw',
      tool_name: 'Shell',
      tool_use_id: 'tool-2',
      tool_output: '{"output":"ok","exitCode":0}',
      duration: 12.5,
    };
    await fs.writeFile(logFile, `${JSON.stringify(record)}\n`);

    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    expect(entries).toHaveLength(1);
    expect(entries[0]!['event.name']).toBe('tool.result');
    expect(entries[0]!['session.id']).toBe('sess-from-raw');
    expect(entries[0]!['request.model']).toBe('unknown');
    expect(entries[0]!['response.model']).toBe('unknown');
    expect(entries[0]!['tool.result.payload']).toEqual({ output: 'ok', exitCode: 0 });
    expect(entries[0]!['tool.result.status']).toBe('success');
    expect(entries[0]!['tool.result.duration_ms']).toBe(12.5);
  });

  it('maps agent thought to llm.response output messages', async () => {
    const today = getTodayDateString();
    const logFile = path.join(tmpDir, `cursor-${today}.jsonl`);
    const record = {
      'event.id': 'r-3',
      observed_time_unix_nano: '1777628163513000000',
      time_unix_nano: '1777628163513000000',
      hook_event_name: 'afterAgentThought',
      session_id: 's-thought',
      text: 'thinking...',
      model: 'gpt-5.5',
    };
    await fs.writeFile(logFile, `${JSON.stringify(record)}\n`);

    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    expect(entries).toHaveLength(1);
    expect(entries[0]!['event.name']).toBe('llm.response');
    expect(entries[0]!['message.role']).toBe('assistant');
    expect(entries[0]!['output.messages']).toEqual([{ type: 'reasoning', content: 'thinking...' }]);
  });

  it('maps prompt, token, and cost fields', async () => {
    const today = getTodayDateString();
    const logFile = path.join(tmpDir, `cursor-${today}.jsonl`);
    const record = {
      'event.id': 'r-4',
      observed_time_unix_nano: '1777628163513000000',
      time_unix_nano: '1777628163513000000',
      hook_event_name: 'beforeSubmitPrompt',
      session_id: 's-prompt',
      generation_id: 'turn-prompt',
      model: 'gpt-5.5',
      prompt: 'please inspect this',
      input_tokens: 10,
      output_tokens: 4,
      cache_read_tokens: 2,
      cache_write_tokens: 1,
      cost_input: 0.1,
      cost_output: 0.2,
      user_email: 'cursor@example.com',
      transcript_path: '/tmp/transcript.jsonl',
    };
    await fs.writeFile(logFile, `${JSON.stringify(record)}\n`);

    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    expect(entries).toHaveLength(1);
    expect(entries[0]!['event.name']).toBe('llm.request');
    expect(entries[0]!['message.role']).toBe('user');
    expect(entries[0]!['user.id']).toBe('');
    expect(entries[0]!['input.messages_delta']).toEqual([{ role: 'user', content: 'please inspect this' }]);
    expect(entries[0]!['usage.input_tokens']).toBe(10);
    expect(entries[0]!['usage.output_tokens']).toBe(4);
    expect(entries[0]!['usage.total_tokens']).toBe(14);
    expect(entries[0]!['usage.cache_read_tokens']).toBe(2);
    expect(entries[0]!['usage.cache_write_tokens']).toBe(1);
    expect(entries[0]!['cost.input']).toBe(0.1);
    expect(entries[0]!['cost.output']).toBe(0.2);
    expect(entries[0]!.attributes?.user_email).toBe('cursor@example.com');
    expect(entries[0]!.attributes?.transcript_path).toBe('/tmp/transcript.jsonl');
  });

  it('maps postToolUseFailure to error fields', async () => {
    const today = getTodayDateString();
    const logFile = path.join(tmpDir, `cursor-${today}.jsonl`);
    const record = {
      'event.id': 'r-5',
      observed_time_unix_nano: '1777628163513000000',
      time_unix_nano: '1777628163513000000',
      hook_event_name: 'postToolUseFailure',
      session_id: 's-fail',
      tool_name: 'Shell',
      tool_use_id: 'tool-fail',
      error_message: 'tool failed',
    };
    await fs.writeFile(logFile, `${JSON.stringify(record)}\n`);

    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    expect(entries).toHaveLength(1);
    expect(entries[0]!['event.name']).toBe('tool.result');
    expect(entries[0]!['tool.result.status']).toBe('failure');
    expect(entries[0]!.is_error).toBe(true);
    expect(entries[0]!['error.type']).toBe('tool_use_failure');
    expect(entries[0]!['error.message']).toBe('tool failed');
  });

  it('does not map generic message to error.message for normal events', async () => {
    const today = getTodayDateString();
    const logFile = path.join(tmpDir, `cursor-${today}.jsonl`);
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

    expect(entries).toHaveLength(1);
    expect(entries[0]!['event.name']).toBe('event');
    expect(entries[0]!['request.model']).toBe('unknown');
    expect(entries[0]!['response.model']).toBe('unknown');
    expect(entries[0]!['error.message']).toBeUndefined();
  });

  it('maps a raw Cursor fixture shell result', async () => {
    const today = getTodayDateString();
    const logFile = path.join(tmpDir, `cursor-${today}.jsonl`);
    const fixturePath = path.join(
      process.cwd(),
      'tests/fixtures/cursor-hook/raw-cursor-hooks-2026-04-30.jsonl',
    );
    const postToolUseLine = (await fs.readFile(fixturePath, 'utf-8')).split('\n')[1]!;
    await fs.writeFile(logFile, `${postToolUseLine}\n`);

    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    expect(entries).toHaveLength(1);
    expect(entries[0]!['event.name']).toBe('tool.result');
    expect(entries[0]!['agent.type']).toBe(ClientType.Cursor);
    expect(entries[0]!['session.id']).toBeTruthy();
    expect(entries[0]!['tool.name']).toBe('Shell');
    expect(entries[0]!['tool.result.payload']).toMatchObject({ output: '' });
  });
});
