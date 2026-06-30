import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { StateStore } from '../../../../src/checkpoints/state-store.js';
import { CodexTranscriptInput } from '../../../../src/inputs/codex-transcript/codex-transcript-input.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for entries');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function record(timestamp: string, type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp, type, payload });
}

function tokenUsage(input: number, output: number): Record<string, unknown> {
  return {
    type: 'token_count',
    info: {
      last_token_usage: {
        input_tokens: input,
        output_tokens: output,
        cached_input_tokens: 0,
        reasoning_output_tokens: output - 1,
        total_tokens: input + output,
      },
    },
  };
}

function entryTimestampMs(entry: AgentActivityEntry): number {
  return Number(BigInt(String(entry.time_unix_nano)) / 1_000_000n);
}

function completedTurn(): string {
  return [
    record('2026-06-24T06:00:00.000Z', 'session_meta', {
      id: 'session-1', model_provider: 'openai',
    }),
    record('2026-06-24T06:00:01.000Z', 'turn_context', {
      turn_id: 'turn-1', model: 'gpt-5.5', cwd: '/tmp/project',
    }),
    record('2026-06-24T06:00:02.000Z', 'event_msg', {
      type: 'task_started', turn_id: 'turn-1',
    }),
    record('2026-06-24T06:00:03.000Z', 'response_item', {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix it' }],
    }),
    record('2026-06-24T06:00:04.000Z', 'event_msg', {
      type: 'agent_message', message: 'inspect the script first', phase: 'commentary',
    }),
    record('2026-06-24T06:00:05.000Z', 'response_item', {
      type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'exec_command', arguments: JSON.stringify({ cmd: 'pwd' }),
    }),
    record('2026-06-24T06:00:06.000Z', 'response_item', {
      type: 'function_call_output', call_id: 'call-1', output: '"/tmp/project"',
    }),
    record('2026-06-24T06:00:06.000Z', 'event_msg', tokenUsage(100, 10)),
    record('2026-06-24T06:00:07.000Z', 'event_msg', {
      type: 'agent_message', message: 'apply the focused patch', phase: 'commentary',
    }),
    record('2026-06-24T06:00:08.000Z', 'response_item', {
      type: 'custom_tool_call', call_id: 'call-2', name: 'apply_patch', input: '*** Begin Patch\n*** End Patch',
    }),
    record('2026-06-24T06:00:09.000Z', 'response_item', {
      type: 'custom_tool_call_output', call_id: 'call-2', output: 'Done',
    }),
    record('2026-06-24T06:00:09.000Z', 'event_msg', tokenUsage(120, 12)),
    record('2026-06-24T06:00:10.000Z', 'event_msg', {
      type: 'agent_message', message: 'fixed', phase: 'final',
    }),
    record('2026-06-24T06:00:10.000Z', 'event_msg', tokenUsage(130, 13)),
    record('2026-06-24T06:00:11.000Z', 'event_msg', {
      type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'fixed', completed_at: 1_719_208_011,
    }),
  ].join('\n') + '\n';
}

async function createInput(root: string): Promise<{
  input: CodexTranscriptInput;
  entries: AgentActivityEntry[];
  sessionDir: string;
}> {
  const stateStore = new StateStore(path.join(root, 'input-state.json'));
  await stateStore.load();
  const sessionDir = path.join(root, 'sessions');
  const input = new CodexTranscriptInput({ stateStore, sessionDir, pollIntervalMs: 10 });
  const entries: AgentActivityEntry[] = [];
  input.on('entries', batch => entries.push(...batch));
  await input.start();
  return { input, entries, sessionDir };
}

async function writeTranscript(sessionDir: string, text: string): Promise<string> {
  const transcript = path.join(sessionDir, '2026', '06', '24', 'rollout-session-1.jsonl');
  await fs.mkdir(path.dirname(transcript), { recursive: true });
  await fs.writeFile(transcript, text, 'utf8');
  return transcript;
}

describe('CodexTranscriptInput', () => {
  it('emits a terminal LLM pair with zero usage for a completed turn without output', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-empty-completed-'));
    tempDirs.push(root);
    const { input, entries, sessionDir } = await createInput(root);
    await writeTranscript(sessionDir, [
      record('2026-06-24T06:00:00.000Z', 'session_meta', { id: 'session-1', model_provider: 'openai' }),
      record('2026-06-24T06:00:01.000Z', 'turn_context', { turn_id: 'turn-1', model: 'gpt-5.5' }),
      record('2026-06-24T06:00:02.000Z', 'event_msg', { type: 'task_started', turn_id: 'turn-1' }),
      record('2026-06-24T06:00:03.000Z', 'response_item', {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: 'acknowledge' }],
      }),
      record('2026-06-24T06:00:04.000Z', 'event_msg', { type: 'task_complete', turn_id: 'turn-1' }),
    ].join('\n') + '\n');

    await waitFor(() => entries.some(entry => entry['event.name'] === 'other'));
    await input.stop();

    const requests = entries.filter(entry => entry['event.name'] === 'llm.request');
    const responses = entries.filter(entry => entry['event.name'] === 'llm.response');
    expect(requests).toHaveLength(1);
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      'gen_ai.response.finish_reasons': ['stop'],
      'gen_ai.usage.input_tokens': 0,
      'gen_ai.usage.output_tokens': 0,
      'gen_ai.usage.cache_read.input_tokens': 0,
      'gen_ai.usage.total_tokens': 0,
    });
  });

  it('uses transcript activity and web_search_end for non-zero web search and LLM timing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-web-search-'));
    tempDirs.push(root);
    const { input, entries, sessionDir } = await createInput(root);
    await writeTranscript(sessionDir, [
      record('2026-06-24T06:00:00.000Z', 'session_meta', { id: 'session-1', model_provider: 'openai' }),
      record('2026-06-24T06:00:01.000Z', 'turn_context', { turn_id: 'turn-1', model: 'gpt-5.5' }),
      record('2026-06-24T06:00:02.000Z', 'event_msg', { type: 'task_started', turn_id: 'turn-1' }),
      record('2026-06-24T06:00:03.000Z', 'response_item', {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: 'search it' }],
      }),
      record('2026-06-24T06:00:04.000Z', 'response_item', { type: 'reasoning', id: 'reasoning-1' }),
      record('2026-06-24T06:00:08.000Z', 'event_msg', {
        type: 'web_search_end', call_id: 'ws-1', action: { type: 'search', query: 'test' },
      }),
      record('2026-06-24T06:00:08.010Z', 'response_item', {
        type: 'web_search_call', id: 'ws-1', status: 'completed', action: { type: 'search', query: 'test' },
      }),
      record('2026-06-24T06:00:09.000Z', 'event_msg', { type: 'agent_message', message: 'found it', phase: 'final' }),
      record('2026-06-24T06:00:09.000Z', 'event_msg', tokenUsage(100, 10)),
      record('2026-06-24T06:00:10.000Z', 'event_msg', {
        type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'found it',
      }),
    ].join('\n') + '\n');

    await waitFor(() => entries.some(entry => entry['event.name'] === 'tool.result'));
    await input.stop();

    const request = entries.find(entry => entry['event.name'] === 'llm.request')!;
    const response = entries.find(entry => entry['event.name'] === 'llm.response')!;
    const toolCall = entries.find(entry => entry['event.name'] === 'tool.call')!;
    const toolResult = entries.find(entry => entry['event.name'] === 'tool.result')!;
    expect(entryTimestampMs(request)).toBe(Date.parse('2026-06-24T06:00:03.000Z'));
    expect(entryTimestampMs(response)).toBe(Date.parse('2026-06-24T06:00:04.000Z'));
    expect(entryTimestampMs(toolCall)).toBe(Date.parse('2026-06-24T06:00:04.000Z'));
    expect(entryTimestampMs(toolResult)).toBe(Date.parse('2026-06-24T06:00:08.000Z'));
    expect(toolResult['gen_ai.tool.call.duration']).toBe(4_000);
  });

  it('uses web_search_end as the LLM response boundary when Codex omits pre-tool reasoning', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-web-search-no-reasoning-'));
    tempDirs.push(root);
    const { input, entries, sessionDir } = await createInput(root);
    await writeTranscript(sessionDir, [
      record('2026-06-24T06:00:00.000Z', 'session_meta', { id: 'session-1', model_provider: 'openai' }),
      record('2026-06-24T06:00:01.000Z', 'turn_context', { turn_id: 'turn-1', model: 'gpt-5.5' }),
      record('2026-06-24T06:00:02.000Z', 'event_msg', { type: 'task_started', turn_id: 'turn-1' }),
      record('2026-06-24T06:00:03.000Z', 'response_item', {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: 'search it' }],
      }),
      record('2026-06-24T06:00:08.000Z', 'event_msg', {
        type: 'web_search_end', call_id: 'ws-1', action: { type: 'search', query: 'test' },
      }),
      record('2026-06-24T06:00:08.010Z', 'response_item', {
        type: 'web_search_call', id: 'ws-1', status: 'completed', action: { type: 'search', query: 'test' },
      }),
      record('2026-06-24T06:00:09.000Z', 'event_msg', { type: 'agent_message', message: 'found it', phase: 'final' }),
      record('2026-06-24T06:00:09.000Z', 'event_msg', tokenUsage(100, 10)),
      record('2026-06-24T06:00:10.000Z', 'event_msg', {
        type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'found it',
      }),
    ].join('\n') + '\n');

    await waitFor(() => entries.some(entry => entry['event.name'] === 'tool.result'));
    await input.stop();

    const request = entries.find(entry => entry['event.name'] === 'llm.request')!;
    const response = entries.find(entry => entry['event.name'] === 'llm.response')!;
    expect(entryTimestampMs(request)).toBe(Date.parse('2026-06-24T06:00:03.000Z'));
    expect(entryTimestampMs(response)).toBe(Date.parse('2026-06-24T06:00:08.000Z'));
  });

  it('rebuilds completed transcript waves without collapsing reasoning or token usage', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-'));
    tempDirs.push(root);
    const { input, entries, sessionDir } = await createInput(root);
    await writeTranscript(sessionDir, completedTurn());

    await waitFor(() => entries.filter(entry => entry['event.name'] === 'llm.response').length === 3);
    await input.stop();

    const responses = entries.filter(entry => entry['event.name'] === 'llm.response');
    expect(responses.map(entry => entry['gen_ai.usage.total_tokens'])).toEqual([110, 132, 143]);
    expect(responses.map(entry => entry['gen_ai.response.finish_reasons'])).toEqual([
      ['tool_call'], ['tool_call'], ['stop'],
    ]);
    expect(entryTimestampMs(responses[0]!)).toBe(Date.parse('2026-06-24T06:00:05.000Z'));
    expect(entryTimestampMs(responses[1]!)).toBe(Date.parse('2026-06-24T06:00:08.000Z'));
    expect(responses[0]?.['gen_ai.response.id']).toBe('fc-1');
    expect(entries.find(entry => entry['event.name'] === 'llm.request')?.['gen_ai.response.id']).toBe('fc-1');
    expect(responses[0]?.['gen_ai.output.messages']?.[0]?.parts).toContainEqual({
      type: 'reasoning', content: 'inspect the script first',
    });
    expect(responses[1]?.['gen_ai.output.messages']?.[0]?.parts).toContainEqual({
      type: 'reasoning', content: 'apply the focused patch',
    });
    expect(responses[2]?.['gen_ai.output.messages']).toEqual([{
      role: 'assistant',
      parts: [{ type: 'text', content: 'fixed' }],
      finish_reason: 'stop',
    }]);

    const requests = entries.filter(entry => entry['event.name'] === 'llm.request');
    expect(requests[1]?.['gen_ai.input.messages']).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'fix it' }] },
      {
        role: 'assistant',
        parts: [{
          type: 'tool_call', id: 'call-1', name: 'exec_command', arguments: { command: 'pwd' },
        }],
      },
      {
        role: 'tool',
        parts: [{ type: 'tool_call_response', id: 'call-1', response: '/tmp/project' }],
      },
    ]);
    expect(requests[2]?.['gen_ai.input.messages']).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'fix it' }] },
      {
        role: 'assistant',
        parts: [{
          type: 'tool_call', id: 'call-1', name: 'exec_command', arguments: { command: 'pwd' },
        }],
      },
      {
        role: 'tool',
        parts: [{ type: 'tool_call_response', id: 'call-1', response: '/tmp/project' }],
      },
      {
        role: 'assistant',
        parts: [{
          type: 'tool_call', id: 'call-2', name: 'apply_patch', arguments: { command: '*** Begin Patch\n*** End Patch' },
        }],
      },
      {
        role: 'tool',
        parts: [{ type: 'tool_call_response', id: 'call-2', response: 'Done' }],
      },
    ]);
    expect(requests.map(entry => entry['gen_ai.input.messages_hash'])).toEqual([
      expect.any(String), expect.any(String), expect.any(String),
    ]);
    expect(requests[0]?.['gen_ai.input.messages_hash']).not.toBe(requests[1]?.['gen_ai.input.messages_hash']);

    const tools = entries.filter(entry => entry['event.name'] === 'tool.call');
    expect(tools.map(entry => entry['gen_ai.step.id'])).toEqual([
      'session-1:turn-1:s1', 'session-1:turn-1:s2',
    ]);
  });

  it('waits for task_complete before exporting a Stop-triggered transcript', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-pending-'));
    tempDirs.push(root);
    const { input, entries, sessionDir } = await createInput(root);
    const lines = completedTurn().trimEnd().split('\n');
    const terminal = lines.pop()!;
    const transcript = await writeTranscript(sessionDir, lines.join('\n') + '\n');

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(entries).toEqual([]);
    await fs.appendFile(transcript, terminal + '\n', 'utf8');
    await waitFor(() => entries.some(entry => entry['gen_ai.response.finish_reasons']?.includes('stop')));
    await input.stop();
  });

  it('falls back malformed transcript timestamps without emitting Unix epoch spans', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-malformed-time-'));
    tempDirs.push(root);
    const { input, entries, sessionDir } = await createInput(root);
    const lines = [
      record('2026-06-24T06:00:00.000Z', 'session_meta', { id: 'session-1', model_provider: 'openai' }),
      record('2026-06-24T06:00:01.000Z', 'turn_context', { turn_id: 'turn-bad', model: 'gpt-5.5' }),
      record('2026-06-24T06:00:02.000Z', 'response_item', {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: 'bad terminal' }],
      }),
      record('not-a-date', 'event_msg', { type: 'task_complete', turn_id: 'turn-bad' }),
    ];
    await writeTranscript(sessionDir, lines.join('\n') + '\n');

    await waitFor(() => entries.some(entry => entry['event.name'] === 'llm.response'));
    await input.stop();

    expect(Math.min(...entries.map(entryTimestampMs))).toBeGreaterThan(Date.parse('2026-01-01T00:00:00.000Z'));
  });

  it('merges all user messages for the entry prompt while retaining raw input messages', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-prompt-'));
    tempDirs.push(root);
    const { input, entries, sessionDir } = await createInput(root);
    const lines = completedTurn().trimEnd().split('\n');
    lines.splice(4, 0, record('2026-06-24T06:00:03.500Z', 'response_item', {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: 'and run the tests' }],
    }));
    await writeTranscript(sessionDir, lines.join('\n') + '\n');

    await waitFor(() => entries.some(entry => entry['event.name'] === 'llm.response'));
    await input.stop();

    expect(entries.find(entry => entry['event.name'] === 'other')).toMatchObject({
      'gen_ai.input.messages_delta': [{
        role: 'user',
        parts: [{ type: 'text', content: 'fix it\nand run the tests' }],
      }],
    });
    expect(entries.find(entry => entry['event.name'] === 'llm.request')).toMatchObject({
      'gen_ai.input.messages_delta': [
        { role: 'user', parts: [{ type: 'text', content: 'fix it' }] },
        { role: 'user', parts: [{ type: 'text', content: 'and run the tests' }] },
      ],
    });
  });

  it('does not shift a token sample without a completed response wave onto a later step', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-unmatched-token-'));
    tempDirs.push(root);
    const { input, entries, sessionDir } = await createInput(root);
    const lines = completedTurn().trimEnd().split('\n');
    lines.splice(3, 0, record('2026-06-24T06:00:02.500Z', 'event_msg', tokenUsage(1, 1)));
    await writeTranscript(sessionDir, lines.join('\n') + '\n');

    await waitFor(() => entries.filter(entry => entry['event.name'] === 'llm.response').length === 3);
    await input.stop();

    expect(entries.filter(entry => entry['event.name'] === 'llm.response')
      .map(entry => entry['gen_ai.usage.total_tokens'])).toEqual([110, 132, 143]);
  });

  it('uses one transcript collector to close an interrupted turn and cancel its pending tool', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-aborted-'));
    tempDirs.push(root);
    const { input, entries, sessionDir } = await createInput(root);
    const lines = completedTurn().trimEnd().split('\n');
    lines.splice(-3, 3,
      record('2026-06-24T06:00:10.000Z', 'event_msg', {
        type: 'agent_message', message: 'one final operation', phase: 'commentary',
      }),
      record('2026-06-24T06:00:11.000Z', 'response_item', {
        type: 'function_call', call_id: 'call-pending', name: 'exec_command', arguments: JSON.stringify({ cmd: 'sleep 10' }),
      }),
      record('2026-06-24T06:00:12.000Z', 'event_msg', {
        type: 'turn_aborted', turn_id: 'turn-1', reason: 'interrupted',
      }),
    );
    await writeTranscript(sessionDir, lines.join('\n') + '\n');

    await waitFor(() => entries.some(entry => entry['gen_ai.response.finish_reasons']?.includes('cancelled')));
    await input.stop();

    const finalResponse = entries.find(entry => entry['gen_ai.response.finish_reasons']?.includes('cancelled'));
    expect(finalResponse).toMatchObject({
      'agent.codex.turn_status': 'interrupted',
      'gen_ai.output.messages': [{
        role: 'assistant',
        parts: expect.arrayContaining([{ type: 'reasoning', content: 'one final operation' }]),
        finish_reason: 'cancelled',
      }],
    });
    expect(entries.find(entry => entry['event.name'] === 'tool.result' && entry['gen_ai.tool.call.id'] === 'call-pending')).toMatchObject({
      'tool.result.status': 'cancelled',
    });
  });
});
