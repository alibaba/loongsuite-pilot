import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_RESOURCE_ENV_FIELD_MAP } from '../../../../assets/hooks/shared/resource-context.mjs';
import { StateStore } from '../../../../src/checkpoints/state-store.js';
import { CodexTranscriptInput } from '../../../../src/inputs/codex-transcript/codex-transcript-input.js';
import type { AgentActivityEntry, JsonValue } from '../../../../src/types/index.js';

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
      dynamic_tools: [{ name: 'exec_command', description: 'Run a command' }],
    }),
    record('2026-06-24T06:00:01.000Z', 'turn_context', {
      turn_id: 'turn-1',
      model: 'gpt-5.5',
      cwd: '/tmp/project',
      developer_instructions: 'Follow the project conventions.',
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

function completedTurnWithLargeToolOutput(toolOutput: string): string {
  return [
    record('2026-06-24T06:00:00.000Z', 'session_meta', {
      id: 'session-1', model_provider: 'openai',
    }),
    record('2026-06-24T06:00:01.000Z', 'turn_context', {
      turn_id: 'turn-1', model: 'gpt-5.5',
    }),
    record('2026-06-24T06:00:02.000Z', 'event_msg', {
      type: 'task_started', turn_id: 'turn-1',
    }),
    record('2026-06-24T06:00:03.000Z', 'response_item', {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: 'inspect it' }],
    }),
    record('2026-06-24T06:00:04.000Z', 'response_item', {
      type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'exec_command', arguments: JSON.stringify({ cmd: 'cat large.txt' }),
    }),
    record('2026-06-24T06:00:05.000Z', 'response_item', {
      type: 'function_call_output', call_id: 'call-1', output: JSON.stringify(toolOutput),
    }),
    record('2026-06-24T06:00:06.000Z', 'event_msg', tokenUsage(100, 10)),
    record('2026-06-24T06:00:07.000Z', 'response_item', {
      type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }],
    }),
    record('2026-06-24T06:00:08.000Z', 'event_msg', {
      type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'done',
    }),
  ].join('\n') + '\n';
}

function completedTurnWithManyToolWaves(count: number): string {
  const baseMs = Date.parse('2026-06-24T06:00:00.000Z');
  const ts = (seconds: number): string => new Date(baseMs + seconds * 1_000).toISOString();
  const lines = [
    record('2026-06-24T06:00:00.000Z', 'session_meta', {
      id: 'session-1', model_provider: 'openai',
    }),
    record('2026-06-24T06:00:01.000Z', 'turn_context', {
      turn_id: 'turn-1', model: 'gpt-5.5',
    }),
    record('2026-06-24T06:00:02.000Z', 'event_msg', {
      type: 'task_started', turn_id: 'turn-1',
    }),
    record('2026-06-24T06:00:03.000Z', 'response_item', {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run many checks' }],
    }),
  ];

  for (let index = 0; index < count; index++) {
    const second = 4 + index * 3;
    lines.push(
      record(ts(second), 'event_msg', {
        type: 'agent_message', message: `checking ${index}`, phase: 'commentary',
      }),
      record(ts(second + 1), 'response_item', {
        type: 'function_call',
        id: `fc-${index}`,
        call_id: `call-${index}`,
        name: 'exec_command',
        arguments: JSON.stringify({ cmd: `echo ${index}` }),
      }),
      record(ts(second + 2), 'response_item', {
        type: 'function_call_output',
        call_id: `call-${index}`,
        output: JSON.stringify(String(index)),
      }),
      record(new Date(baseMs + (second + 2) * 1_000 + 100).toISOString(), 'event_msg', tokenUsage(100 + index, 10)),
    );
  }

  lines.push(
    record('2026-06-24T06:10:00.000Z', 'event_msg', {
      type: 'agent_message', message: 'done', phase: 'final',
    }),
    record('2026-06-24T06:10:00.100Z', 'event_msg', tokenUsage(1_000, 20)),
    record('2026-06-24T06:10:01.000Z', 'event_msg', {
      type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'done',
    }),
  );
  return lines.join('\n') + '\n';
}

function simpleCompletedTurn(
  sessionId: string,
  turnId: string,
  prompt: string,
  response: string,
  usageInput: number,
  usageOutput: number,
  start: string,
): string[] {
  const baseMs = Date.parse(start);
  const at = (offsetMs: number) => new Date(baseMs + offsetMs).toISOString();
  return [
    record(at(0), 'session_meta', {
      id: sessionId, model_provider: 'openai',
    }),
    record(at(1_000), 'turn_context', {
      turn_id: turnId, model: 'gpt-5.5', cwd: '/tmp/project',
    }),
    record(at(2_000), 'event_msg', {
      type: 'task_started', turn_id: turnId,
    }),
    record(at(3_000), 'response_item', {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }],
    }),
    record(at(4_000), 'event_msg', {
      type: 'agent_message', message: response, phase: 'final',
    }),
    record(at(4_000), 'event_msg', tokenUsage(usageInput, usageOutput)),
    record(at(5_000), 'event_msg', {
      type: 'task_complete', turn_id: turnId, last_agent_message: response,
    }),
  ];
}

function controlOnlyAbortedTurn(sessionId: string, turnId: string, start: string): string[] {
  const baseMs = Date.parse(start);
  const at = (offsetMs: number) => new Date(baseMs + offsetMs).toISOString();
  return [
    record(at(0), 'event_msg', { type: 'task_started', turn_id: turnId }),
    record(at(1_000), 'turn_context', { turn_id: turnId, model: 'gpt-5.5' }),
    record(at(2_000), 'session_meta', { id: sessionId, model_provider: 'openai' }),
    record(at(3_000), 'response_item', {
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: '<turn_aborted> previous turn interrupted' }],
    }),
    record(at(4_000), 'event_msg', { type: 'turn_aborted', turn_id: turnId }),
  ];
}

async function createInput(root: string, pollIntervalMs = 10): Promise<{
  input: CodexTranscriptInput;
  entries: AgentActivityEntry[];
  batches: AgentActivityEntry[][];
  sessionDir: string;
  wakeupDir: string;
  stateStore: StateStore;
}> {
  const stateStore = new StateStore(path.join(root, 'input-state.json'));
  await stateStore.load();
  const sessionDir = path.join(root, 'sessions');
  const wakeupDir = path.join(root, 'wakeups');
  const input = new CodexTranscriptInput({ stateStore, sessionDir, wakeupDir, pollIntervalMs });
  const entries: AgentActivityEntry[] = [];
  const batches: AgentActivityEntry[][] = [];
  input.on('entries', batch => {
    batches.push([...batch]);
    entries.push(...batch);
  });
  await input.start();
  return { input, entries, batches, sessionDir, wakeupDir, stateStore };
}

async function createDormantInput(root: string): Promise<{
  input: CodexTranscriptInput;
  entries: AgentActivityEntry[];
  batches: AgentActivityEntry[][];
  sessionDir: string;
  wakeupDir: string;
  stateStore: StateStore;
}> {
  const stateStore = new StateStore(path.join(root, 'input-state.json'));
  await stateStore.load();
  const sessionDir = path.join(root, 'sessions');
  const wakeupDir = path.join(root, 'wakeups');
  const input = new CodexTranscriptInput({ stateStore, sessionDir, wakeupDir, pollIntervalMs: 60_000 });
  const entries: AgentActivityEntry[] = [];
  const batches: AgentActivityEntry[][] = [];
  input.on('entries', batch => {
    batches.push([...batch]);
    entries.push(...batch);
  });
  return { input, entries, batches, sessionDir, wakeupDir, stateStore };
}

async function writeTranscript(sessionDir: string, text: string): Promise<string> {
  const transcript = path.join(sessionDir, '2026', '06', '24', 'rollout-session-1.jsonl');
  await fs.mkdir(path.dirname(transcript), { recursive: true });
  await fs.writeFile(transcript, text, 'utf8');
  return transcript;
}

async function writeWakeupMarker(wakeupDir: string, sessionId: string, payload: Record<string, unknown>): Promise<void> {
  await fs.mkdir(wakeupDir, { recursive: true });
  await fs.writeFile(path.join(wakeupDir, `${sessionId}.json`), JSON.stringify(payload), 'utf8');
}

async function writeTranscriptNamed(sessionDir: string, name: string, text: string): Promise<string> {
  const transcript = path.join(sessionDir, '2026', '06', '24', name);
  await fs.mkdir(path.dirname(transcript), { recursive: true });
  await fs.writeFile(transcript, text, 'utf8');
  return transcript;
}

function responsesForTurn(entries: AgentActivityEntry[], turnId: string): AgentActivityEntry[] {
  return entries.filter(entry =>
    entry['event.name'] === 'llm.response'
    && entry['agent.codex.transcript_turn_id'] === turnId,
  );
}

async function processTranscriptOnce(input: CodexTranscriptInput, transcript: string): Promise<number> {
  return (input as unknown as { processFile(filePath: string): Promise<number> }).processFile(transcript);
}

function transcriptCheckpoint(
  stateStore: StateStore,
  transcript: string,
): Record<string, unknown> {
  return stateStore.get(`codex-transcript:${transcript}`).extra?.codexTranscript as Record<string, unknown>;
}

function globalProcessedTurnIds(stateStore: StateStore): string[] {
  const global = stateStore.get('codex-transcript').extra?.codexTranscriptGlobal as {
    emittedTerminalTurnIds?: string[];
  } | undefined;
  return global?.emittedTerminalTurnIds ?? [];
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
      'gen_ai.usage.cache_creation.input_tokens': 0,
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

  it('falls back to input message delta when the reconstructed request context exceeds 1MB', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-large-input-'));
    tempDirs.push(root);
    const { input, entries, sessionDir } = await createInput(root);
    const largeToolOutput = 'x'.repeat(1024 * 1024 + 1);
    await writeTranscript(sessionDir, completedTurnWithLargeToolOutput(largeToolOutput));

    await waitFor(() => entries.filter(entry => entry['event.name'] === 'llm.request').length === 2);
    await input.stop();

    const requests = entries.filter(entry => entry['event.name'] === 'llm.request');
    const secondRequest = requests[1]!;
    const expectedDelta = [
      {
        role: 'assistant',
        parts: [{
          type: 'tool_call', id: 'call-1', name: 'exec_command', arguments: { command: 'cat large.txt' },
        }],
      },
      {
        role: 'tool',
        parts: [{ type: 'tool_call_response', id: 'call-1', response: largeToolOutput }],
      },
    ];
    expect(secondRequest['gen_ai.input.messages_delta']).toEqual(expectedDelta);
    expect(secondRequest['gen_ai.input.messages']).toEqual(expectedDelta);
    expect(secondRequest['gen_ai.input.messages_hash']).toEqual(expect.any(String));
  });

  it('emits long transcript turns in bounded batches', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-batches-'));
    tempDirs.push(root);
    const { input, entries, batches, sessionDir } = await createInput(root);
    await writeTranscript(sessionDir, completedTurnWithManyToolWaves(80));

    await waitFor(() => entries.filter(entry => entry['event.name'] === 'tool.result').length === 80);
    await input.stop();

    expect(entries.length).toBeGreaterThan(256);
    expect(batches.length).toBeGreaterThan(1);
    expect(Math.max(...batches.map(batch => batch.length))).toBeLessThanOrEqual(256);
  });

  it('projects AgentTeams resource context from the Stop wakeup marker', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-agentteams-'));
    tempDirs.push(root);
    const { input, entries, sessionDir, wakeupDir } = await createInput(root);
    await writeWakeupMarker(wakeupDir, 'session-1', {
      session_id: 'session-1',
      resourceAttributes: {
        'agentteams.worker.name': ' codex-worker ',
        'agentteams.instance.id': ' lw-codex ',
        'agentteams.token': 'should-not-leak',
        'custom.key': 'ignored',
      },
    });
    await writeTranscript(sessionDir, completedTurn());

    await waitFor(() => entries.filter(entry => entry['event.name'] === 'llm.response').length === 3);
    await input.stop();

    for (const entry of entries) {
      expect(entry['gen_ai.agent.name']).toBe('codex-worker');
      expect(entry.resourceAttributes).toEqual({
        'agentteams.worker.name': 'codex-worker',
        'agentteams.instance.id': 'lw-codex',
      });
      expect(entry['agentteams.worker.name']).toBeUndefined();
      expect(entry['agentteams.instance.id']).toBeUndefined();
      expect(entry['agentteams.token']).toBeUndefined();
      expect(entry['custom.key']).toBeUndefined();
    }
    expect(JSON.stringify(entries)).not.toContain('should-not-leak');
    expect(JSON.stringify(entries)).not.toContain('ignored');
  });

  it('keeps Codex wakeup resource fields aligned with the shared hook env map', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-agentteams-map-'));
    tempDirs.push(root);
    const { input, entries, sessionDir, wakeupDir } = await createInput(root);
    const resourceAttributes = Object.fromEntries(
      Object.values(DEFAULT_RESOURCE_ENV_FIELD_MAP).map((key, index) => [key, `value-${index}`]),
    );
    await writeWakeupMarker(wakeupDir, 'session-1', {
      session_id: 'session-1',
      resourceAttributes,
    });
    await writeTranscript(sessionDir, completedTurn());

    await waitFor(() => entries.filter(entry => entry['event.name'] === 'llm.response').length === 3);
    await input.stop();

    for (const entry of entries) {
      expect(entry.resourceAttributes).toEqual(resourceAttributes);
    }
  });

  it('skips overlong AgentTeams resource values from the wakeup marker', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-agentteams-long-'));
    tempDirs.push(root);
    const { input, entries, sessionDir, wakeupDir } = await createInput(root);
    const longWorkerName = 'x'.repeat(513);
    await writeWakeupMarker(wakeupDir, 'session-1', {
      session_id: 'session-1',
      resourceAttributes: {
        'agentteams.worker.name': longWorkerName,
        'agentteams.instance.id': 'lw-codex',
      },
    });
    await writeTranscript(sessionDir, completedTurn());

    await waitFor(() => entries.filter(entry => entry['event.name'] === 'llm.response').length === 3);
    await input.stop();

    for (const entry of entries) {
      expect(entry['gen_ai.agent.name']).toBeUndefined();
      expect(entry.resourceAttributes).toEqual({
        'agentteams.instance.id': 'lw-codex',
      });
    }
    expect(JSON.stringify(entries)).not.toContain(longWorkerName);
  });

  it('debug logs when an existing wakeup marker lacks resourceAttributes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-agentteams-empty-marker-'));
    tempDirs.push(root);
    const { input, entries, sessionDir, wakeupDir } = await createInput(root);
    const debug = vi.fn();
    (input as unknown as { logger: { debug: typeof debug } }).logger.debug = debug;
    await writeWakeupMarker(wakeupDir, 'session-1', { session_id: 'session-1' });
    await writeTranscript(sessionDir, completedTurn());

    await waitFor(() => entries.filter(entry => entry['event.name'] === 'llm.response').length === 3);
    await input.stop();

    expect(entries.some(entry => entry.resourceAttributes)).toBe(false);
    expect(debug).toHaveBeenCalledWith(
      'Codex wakeup marker has no resourceAttributes; attribution skipped',
      { marker: path.join(wakeupDir, 'session-1.json') },
    );
  });

  it('consumes a control-only aborted turn and emits later normal work in the same cycle', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-control-abort-'));
    tempDirs.push(root);
    const { input, entries, sessionDir, stateStore } = await createDormantInput(root);
    const debug = vi.fn();
    const warn = vi.fn();
    (input as unknown as { logger: { debug: typeof debug; warn: typeof warn } }).logger.debug = debug;
    (input as unknown as { logger: { debug: typeof debug; warn: typeof warn } }).logger.warn = warn;
    const controlTurnId = 'turn-control';
    const normalTurnId = 'turn-normal';
    const transcript = await writeTranscript(
      sessionDir,
      [
        ...controlOnlyAbortedTurn('session-1', controlTurnId, '2026-06-24T06:00:00.000Z'),
        ...simpleCompletedTurn(
          'session-1', normalTurnId, 'continue work', 'work completed', 120, 12,
          '2026-06-24T06:01:00.000Z',
        ).slice(1),
      ].join('\n') + '\n',
    );

    await processTranscriptOnce(input, transcript);

    expect(entries.filter(entry => entry['agent.codex.transcript_turn_id'] === controlTurnId)).toHaveLength(0);
    expect(responsesForTurn(entries, normalTurnId)).toHaveLength(1);
    const checkpoint = transcriptCheckpoint(stateStore, transcript) as {
      activeTurn?: unknown;
      pendingTerminal?: unknown;
      emittedTerminalTurnIds?: string[];
    };
    expect(checkpoint.activeTurn).toBeNull();
    expect(checkpoint.pendingTerminal).toBeNull();
    expect(checkpoint.emittedTerminalTurnIds).toEqual(expect.arrayContaining([controlTurnId, normalTurnId]));
    expect(globalProcessedTurnIds(stateStore)).toEqual(expect.arrayContaining([controlTurnId, normalTurnId]));
    expect(debug).toHaveBeenCalledWith(
      'processed terminal Codex turn without observable entries',
      expect.objectContaining({ turnId: controlTurnId, terminalStatus: 'interrupted' }),
    );
    expect(warn).not.toHaveBeenCalledWith(
      'processed terminal Codex turn produced no explainable new entries',
      expect.anything(),
    );
  });

  it('keeps collecting normal turns after a control abort in a rollout created while running', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-live-control-abort-'));
    tempDirs.push(root);
    const { input, entries, sessionDir, stateStore } = await createInput(root);
    const debug = vi.fn();
    (input as unknown as { logger: { debug: typeof debug } }).logger.debug = debug;

    const beforeTurnIds = ['turn-before-1', 'turn-before-2', 'turn-before-3'];
    const controlTurnId = 'turn-control';
    const afterTurnId = 'turn-after';
    const transcriptLines = [
      ...simpleCompletedTurn(
        'session-1', beforeTurnIds[0]!, 'first request', 'first response', 100, 10,
        '2026-06-24T06:00:00.000Z',
      ),
      ...simpleCompletedTurn(
        'session-1', beforeTurnIds[1]!, 'second request', 'second response', 110, 11,
        '2026-06-24T06:01:00.000Z',
      ).slice(1),
      ...simpleCompletedTurn(
        'session-1', beforeTurnIds[2]!, 'third request', 'third response', 120, 12,
        '2026-06-24T06:02:00.000Z',
      ).slice(1),
      ...controlOnlyAbortedTurn('session-1', controlTurnId, '2026-06-24T06:03:00.000Z'),
      ...simpleCompletedTurn(
        'session-1', afterTurnId, 'request after abort', 'response after abort', 130, 13,
        '2026-06-24T06:04:00.000Z',
      ).slice(1),
    ];
    const transcript = await writeTranscript(sessionDir, transcriptLines.join('\n') + '\n');

    await waitFor(() => responsesForTurn(entries, afterTurnId).length === 1);
    await input.stop();

    const normalTurnIds = [...beforeTurnIds, afterTurnId];
    expect(normalTurnIds.map(turnId => responsesForTurn(entries, turnId).length)).toEqual([1, 1, 1, 1]);
    expect(entries.filter(entry => entry['agent.codex.transcript_turn_id'] === controlTurnId)).toHaveLength(0);
    expect(entries.filter(entry => entry['event.name'] === 'llm.response')
      .map(entry => entry['gen_ai.usage.total_tokens'])).toEqual([110, 121, 132, 143]);
    expect(new Set(entries.map(entry => entry['event.id'])).size).toBe(entries.length);

    const checkpoint = transcriptCheckpoint(stateStore, transcript) as {
      scanOffset?: number;
      activeTurn?: unknown;
      pendingTerminal?: unknown;
      emittedTerminalTurnIds?: string[];
    };
    expect(checkpoint.scanOffset).toBe((await fs.stat(transcript)).size);
    expect(checkpoint.activeTurn).toBeNull();
    expect(checkpoint.pendingTerminal).toBeNull();
    expect(checkpoint.emittedTerminalTurnIds).toEqual(
      expect.arrayContaining([...normalTurnIds, controlTurnId]),
    );
    expect(globalProcessedTurnIds(stateStore)).toEqual(
      expect.arrayContaining([...normalTurnIds, controlTurnId]),
    );
    expect(debug).toHaveBeenCalledWith(
      'processed terminal Codex turn without observable entries',
      expect.objectContaining({ turnId: controlTurnId, terminalStatus: 'interrupted' }),
    );
  });

  it('limits terminal recovery per file cycle and resumes from the saved offset', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-terminal-budget-'));
    tempDirs.push(root);
    const { input, entries, sessionDir, stateStore } = await createDormantInput(root);
    const lines: string[] = [];
    for (let index = 0; index < 101; index++) {
      const turn = simpleCompletedTurn(
        'session-1', `turn-${index}`, `prompt ${index}`, `response ${index}`, 100 + index, 10,
        new Date(Date.parse('2026-06-24T06:00:00.000Z') + index * 10_000).toISOString(),
      );
      lines.push(...(index === 0 ? turn : turn.slice(1)));
    }
    const transcript = await writeTranscript(sessionDir, lines.join('\n') + '\n');
    const transcriptSize = (await fs.stat(transcript)).size;

    await processTranscriptOnce(input, transcript);
    expect(entries.filter(entry => entry['event.name'] === 'llm.response')).toHaveLength(100);
    expect((transcriptCheckpoint(stateStore, transcript) as { scanOffset?: number }).scanOffset)
      .toBeLessThan(transcriptSize);

    await processTranscriptOnce(input, transcript);
    expect(entries.filter(entry => entry['event.name'] === 'llm.response')).toHaveLength(101);
    expect((transcriptCheckpoint(stateStore, transcript) as { scanOffset?: number }).scanOffset)
      .toBe(transcriptSize);
  });

  it('skips copied history, consumes a control abort, and emits new fork work in one cycle', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-fork-control-abort-'));
    tempDirs.push(root);
    const { input, entries, sessionDir, stateStore } = await createDormantInput(root);
    const historyTurnId = 'turn-history';
    const controlTurnId = 'turn-control';
    const forkTurnId = 'turn-fork-new';
    const history = simpleCompletedTurn(
      'session-parent', historyTurnId, 'parent work', 'parent done', 100, 10,
      '2026-06-24T06:00:00.000Z',
    );
    const parent = await writeTranscriptNamed(sessionDir, 'rollout-parent.jsonl', history.join('\n') + '\n');
    await processTranscriptOnce(input, parent);

    const fork = await writeTranscriptNamed(
      sessionDir,
      'rollout-fork.jsonl',
      [
        record('2026-06-24T06:10:00.000Z', 'session_meta', {
          id: 'session-fork', model_provider: 'openai', forked_from_id: 'session-parent',
        }),
        ...history.slice(1),
        ...controlOnlyAbortedTurn('session-fork', controlTurnId, '2026-06-24T06:11:00.000Z'),
        ...simpleCompletedTurn(
          'session-fork', forkTurnId, 'continue fork work', 'fork work completed', 130, 13,
          '2026-06-24T06:12:00.000Z',
        ).slice(1),
      ].join('\n') + '\n',
    );
    await processTranscriptOnce(input, fork);

    expect(responsesForTurn(entries, historyTurnId)).toHaveLength(1);
    expect(entries.filter(entry => entry['agent.codex.transcript_turn_id'] === controlTurnId)).toHaveLength(0);
    expect(responsesForTurn(entries, forkTurnId)).toHaveLength(1);
    const checkpoint = transcriptCheckpoint(stateStore, fork) as {
      activeTurn?: unknown;
      pendingTerminal?: unknown;
      emittedTerminalTurnIds?: string[];
    };
    expect(checkpoint.activeTurn).toBeNull();
    expect(checkpoint.pendingTerminal).toBeNull();
    expect(checkpoint.emittedTerminalTurnIds).toEqual(
      expect.arrayContaining([historyTurnId, controlTurnId, forkTurnId]),
    );
    expect(globalProcessedTurnIds(stateStore)).toContain(controlTurnId);

    await stateStore.save();
    const restarted = await createDormantInput(root);
    const debug = vi.fn();
    (restarted.input as unknown as { logger: { debug: typeof debug } }).logger.debug = debug;
    const restartedTurnId = 'turn-fork-after-restart';
    const secondFork = await writeTranscriptNamed(
      restarted.sessionDir,
      'rollout-fork-after-restart.jsonl',
      [
        record('2026-06-24T06:20:00.000Z', 'session_meta', {
          id: 'session-fork-2', model_provider: 'openai', forked_from_id: 'session-fork',
        }),
        ...controlOnlyAbortedTurn('session-fork-2', controlTurnId, '2026-06-24T06:21:00.000Z'),
        ...simpleCompletedTurn(
          'session-fork-2', restartedTurnId, 'continue after restart', 'restart work completed', 140, 14,
          '2026-06-24T06:22:00.000Z',
        ).slice(1),
      ].join('\n') + '\n',
    );
    await processTranscriptOnce(restarted.input, secondFork);

    expect(responsesForTurn(restarted.entries, restartedTurnId)).toHaveLength(1);
    expect((transcriptCheckpoint(restarted.stateStore, secondFork) as {
      emittedTerminalTurnIds?: string[];
    }).emittedTerminalTurnIds).toContain(controlTurnId);
    expect(debug).not.toHaveBeenCalledWith(
      'processed terminal Codex turn without observable entries',
      expect.objectContaining({ turnId: controlTurnId }),
    );
  });

  it('clears a legacy empty pending terminal and emits later work during startup collection', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-legacy-empty-pending-'));
    tempDirs.push(root);
    const sessionDir = path.join(root, 'sessions');
    const controlTurnId = 'turn-control';
    const normalTurnId = 'turn-normal';
    const controlLines = controlOnlyAbortedTurn('session-1', controlTurnId, '2026-06-24T06:00:00.000Z');
    const controlText = controlLines.join('\n') + '\n';
    const transcript = await writeTranscriptNamed(
      sessionDir,
      'rollout-session-1.jsonl',
      controlText + simpleCompletedTurn(
        'session-1', normalTurnId, 'continue work', 'work completed', 120, 12,
        '2026-06-24T06:01:00.000Z',
      ).slice(1).join('\n') + '\n',
    );
    const stat = await fs.stat(transcript);
    const terminalEndOffset = Buffer.byteLength(controlText);
    const sessionMetaOffset = Buffer.byteLength(controlLines.slice(0, 2).join('\n') + '\n');
    const persistedState = new StateStore(path.join(root, 'input-state.json'));
    await persistedState.load();
    persistedState.update(`codex-transcript:${transcript}`, {
      lastOffset: terminalEndOffset,
      extra: {
        codexTranscript: {
          inode: stat.ino,
          scanOffset: terminalEndOffset,
          activeTurn: {
            turnId: controlTurnId,
            startOffset: 0,
            startedAtMs: Date.parse('2026-06-24T06:00:00.000Z'),
            model: 'gpt-5.5',
          },
          pendingTerminal: { turnId: controlTurnId, terminalEndOffset },
          latestSessionMetaOffset: sessionMetaOffset,
          emittedTerminalTurnIds: [],
        },
      },
    });
    await persistedState.save();

    const recovered = await createInput(root, 60_000);
    await recovered.input.stop();

    expect(recovered.entries.filter(entry => entry['agent.codex.transcript_turn_id'] === controlTurnId)).toHaveLength(0);
    expect(responsesForTurn(recovered.entries, normalTurnId)).toHaveLength(1);
    const checkpoint = transcriptCheckpoint(recovered.stateStore, transcript) as {
      activeTurn?: unknown;
      pendingTerminal?: unknown;
      emittedTerminalTurnIds?: string[];
    };
    expect(checkpoint.activeTurn).toBeNull();
    expect(checkpoint.pendingTerminal).toBeNull();
    expect(checkpoint.emittedTerminalTurnIds).toEqual(expect.arrayContaining([controlTurnId, normalTurnId]));
    expect(globalProcessedTurnIds(recovered.stateStore)).toEqual(
      expect.arrayContaining([controlTurnId, normalTurnId]),
    );
  });

  it('retains a truly unparseable pending range and does not scan later work', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-unparseable-pending-'));
    tempDirs.push(root);
    const sessionDir = path.join(root, 'sessions');
    const pendingTurnId = 'turn-unparseable';
    const normalTurnId = 'turn-normal';
    const pendingText = record('2026-06-24T06:00:00.000Z', 'event_msg', {
      type: 'task_started', turn_id: pendingTurnId,
    }) + '\n';
    const transcript = await writeTranscriptNamed(
      sessionDir,
      'rollout-session-1.jsonl',
      pendingText + simpleCompletedTurn(
        'session-1', normalTurnId, 'later work', 'later work completed', 120, 12,
        '2026-06-24T06:01:00.000Z',
      ).join('\n') + '\n',
    );
    const stat = await fs.stat(transcript);
    const terminalEndOffset = Buffer.byteLength(pendingText);
    const stateStore = new StateStore(path.join(root, 'input-state.json'));
    await stateStore.load();
    stateStore.update(`codex-transcript:${transcript}`, {
      lastOffset: terminalEndOffset,
      extra: {
        codexTranscript: {
          inode: stat.ino,
          scanOffset: terminalEndOffset,
          activeTurn: {
            turnId: pendingTurnId,
            startOffset: 0,
            startedAtMs: Date.parse('2026-06-24T06:00:00.000Z'),
          },
          pendingTerminal: { turnId: pendingTurnId, terminalEndOffset },
          latestSessionMetaOffset: null,
          emittedTerminalTurnIds: [],
        },
      },
    });
    await stateStore.save();

    const loadedState = new StateStore(path.join(root, 'input-state.json'));
    await loadedState.load();
    const input = new CodexTranscriptInput({
      stateStore: loadedState,
      sessionDir,
      wakeupDir: path.join(root, 'wakeups'),
      pollIntervalMs: 60_000,
    });
    const entries: AgentActivityEntry[] = [];
    const warn = vi.fn();
    input.on('entries', batch => entries.push(...batch));
    (input as unknown as { logger: { warn: typeof warn } }).logger.warn = warn;
    await input.start();
    await input.stop();

    expect(responsesForTurn(entries, normalTurnId)).toHaveLength(0);
    const checkpoint = transcriptCheckpoint(loadedState, transcript) as {
      scanOffset?: number;
      pendingTerminal?: { turnId?: string; retryCount?: number; sourceRecordCount?: number };
    };
    expect(checkpoint.scanOffset).toBe(terminalEndOffset);
    expect(checkpoint.pendingTerminal).toMatchObject({
      turnId: pendingTurnId,
      retryCount: 1,
      sourceRecordCount: 1,
    });
    expect(warn).toHaveBeenCalledWith(
      'pending Codex terminal turn still could not be parsed; will retry',
      expect.objectContaining({
        transcriptPath: transcript,
        turnId: pendingTurnId,
        retryCount: 1,
        sourceRecordCount: 1,
      }),
    );
  });

  it('does not re-emit completed turns copied into a forked Codex transcript file', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-fork-'));
    tempDirs.push(root);
    const { input, entries, sessionDir } = await createInput(root);

    const originalTurn = simpleCompletedTurn(
      'session-1',
      'turn-1',
      'fix it',
      'fixed once',
      100,
      10,
      '2026-06-24T06:00:00.000Z',
    );
    await writeTranscriptNamed(sessionDir, 'rollout-original.jsonl', originalTurn.join('\n') + '\n');

    await waitFor(() => responsesForTurn(entries, 'turn-1').length === 1);

    const forkedHistory = simpleCompletedTurn(
      'session-1',
      'turn-1',
      'fix it',
      'fixed once',
      100,
      10,
      '2026-06-24T06:10:00.000Z',
    );
    const forkedNewTurn = simpleCompletedTurn(
      'session-1',
      'turn-2',
      'continue from the fork',
      'fixed twice',
      120,
      12,
      '2026-06-24T06:11:00.000Z',
    ).slice(1);
    await writeTranscriptNamed(
      sessionDir,
      'rollout-fork.jsonl',
      [...forkedHistory, ...forkedNewTurn].join('\n') + '\n',
    );

    await waitFor(() => responsesForTurn(entries, 'turn-2').length === 1);
    await new Promise(resolve => setTimeout(resolve, 50));
    await input.stop();

    expect(responsesForTurn(entries, 'turn-1')).toHaveLength(1);
    expect(responsesForTurn(entries, 'turn-2')).toHaveLength(1);
    expect(responsesForTurn(entries, 'turn-1')[0]?.['gen_ai.usage.total_tokens']).toBe(110);
    expect(responsesForTurn(entries, 'turn-2')[0]?.['gen_ai.usage.total_tokens']).toBe(132);
  });

  it('keeps fork dedupe after restarting the Codex transcript input', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-fork-restart-'));
    tempDirs.push(root);
    const first = await createInput(root);

    const originalTurn = simpleCompletedTurn(
      'session-1',
      'turn-1',
      'fix it',
      'fixed once',
      100,
      10,
      '2026-06-24T06:00:00.000Z',
    );
    await writeTranscriptNamed(first.sessionDir, 'rollout-original.jsonl', originalTurn.join('\n') + '\n');

    await waitFor(() => responsesForTurn(first.entries, 'turn-1').length === 1);
    await first.input.stop();

    const restarted = await createInput(root);
    const forkedHistory = simpleCompletedTurn(
      'session-1',
      'turn-1',
      'fix it',
      'fixed once',
      100,
      10,
      '2026-06-24T06:10:00.000Z',
    );
    const forkedNewTurn = simpleCompletedTurn(
      'session-1',
      'turn-2',
      'continue from the fork',
      'fixed twice',
      120,
      12,
      '2026-06-24T06:11:00.000Z',
    ).slice(1);
    await writeTranscriptNamed(
      restarted.sessionDir,
      'rollout-fork.jsonl',
      [...forkedHistory, ...forkedNewTurn].join('\n') + '\n',
    );

    await waitFor(() => responsesForTurn(restarted.entries, 'turn-2').length === 1);
    await new Promise(resolve => setTimeout(resolve, 50));
    await restarted.input.stop();

    expect(responsesForTurn(restarted.entries, 'turn-1')).toHaveLength(0);
    expect(responsesForTurn(restarted.entries, 'turn-2')).toHaveLength(1);
    expect(responsesForTurn(restarted.entries, 'turn-2')[0]?.['gen_ai.usage.total_tokens']).toBe(132);
  });

  it('persists global fork dedupe after baselining an inode-changed transcript file', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-fork-inode-'));
    tempDirs.push(root);
    const first = await createInput(root);

    const originalTurn = simpleCompletedTurn(
      'session-1',
      'turn-1',
      'fix it',
      'fixed once',
      100,
      10,
      '2026-06-24T06:00:00.000Z',
    );
    const transcript = await writeTranscriptNamed(
      first.sessionDir,
      'rollout-original.jsonl',
      originalTurn.join('\n') + '\n',
    );
    await waitFor(() => responsesForTurn(first.entries, 'turn-1').length === 1);
    const originalStat = await fs.stat(transcript);

    const replacementTurn = simpleCompletedTurn(
      'session-1',
      'turn-2',
      'fix it again',
      'fixed from replacement',
      200,
      20,
      '2026-06-24T06:20:00.000Z',
    );
    const replacementTranscript = `${transcript}.replacement`;
    await fs.writeFile(replacementTranscript, replacementTurn.join('\n') + '\n', 'utf8');
    await fs.rename(replacementTranscript, transcript);
    const replacementStat = await fs.stat(transcript);
    expect(replacementStat.ino).not.toBe(originalStat.ino);
    const checkpointKey = `codex-transcript:${transcript}`;
    await waitFor(() => {
      const checkpoint = first.stateStore.get(checkpointKey).extra?.codexTranscript as { inode?: number } | undefined;
      return checkpoint?.inode === replacementStat.ino;
    });
    await first.input.stop();

    const restarted = await createInput(root);
    const forkedHistory = simpleCompletedTurn(
      'session-1',
      'turn-2',
      'fix it again',
      'fixed from replacement',
      200,
      20,
      '2026-06-24T06:30:00.000Z',
    );
    const forkedNewTurn = simpleCompletedTurn(
      'session-1',
      'turn-3',
      'continue after inode change',
      'fixed after inode change',
      300,
      30,
      '2026-06-24T06:31:00.000Z',
    ).slice(1);
    await writeTranscriptNamed(
      restarted.sessionDir,
      'rollout-fork.jsonl',
      [...forkedHistory, ...forkedNewTurn].join('\n') + '\n',
    );

    await waitFor(() => responsesForTurn(restarted.entries, 'turn-3').length === 1);
    await new Promise(resolve => setTimeout(resolve, 50));
    await restarted.input.stop();

    expect(responsesForTurn(restarted.entries, 'turn-2')).toHaveLength(0);
    expect(responsesForTurn(restarted.entries, 'turn-3')).toHaveLength(1);
    expect(responsesForTurn(restarted.entries, 'turn-3')[0]?.['gen_ai.usage.total_tokens']).toBe(330);
  });

  it('exports completed transcript waves before task_complete and flushes stop at terminal', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-pending-'));
    tempDirs.push(root);
    const { input, entries, sessionDir } = await createInput(root);
    const lines = completedTurn().trimEnd().split('\n');
    const terminal = lines.pop()!;
    const transcript = await writeTranscript(sessionDir, lines.join('\n') + '\n');

    await waitFor(() => entries.some(entry => entry['event.name'] === 'tool.result'));
    expect(entries.some(entry => entry['gen_ai.response.finish_reasons']?.includes('stop'))).toBe(false);
    await fs.appendFile(transcript, terminal + '\n', 'utf8');
    await waitFor(() => entries.some(entry => entry['gen_ai.response.finish_reasons']?.includes('stop')));
    await input.stop();
  });

  it('keeps token-delimited message waves as separate steps across collection cycles', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-message-waves-'));
    tempDirs.push(root);
    const { input, entries, sessionDir, stateStore } = await createInput(root, 60_000);
    const firstWave = [
      record('2026-06-24T06:00:00.000Z', 'session_meta', { id: 'session-1', model_provider: 'openai' }),
      record('2026-06-24T06:00:01.000Z', 'turn_context', { turn_id: 'turn-1', model: 'gpt-5.5' }),
      record('2026-06-24T06:00:02.000Z', 'event_msg', { type: 'task_started', turn_id: 'turn-1' }),
      record('2026-06-24T06:00:03.000Z', 'response_item', {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run it' }],
      }),
      record('2026-06-24T06:00:04.000Z', 'event_msg', {
        type: 'agent_message', message: 'A', phase: 'commentary',
      }),
      record('2026-06-24T06:00:05.000Z', 'event_msg', tokenUsage(10, 2)),
    ];
    const transcript = await writeTranscript(sessionDir, firstWave.join('\n') + '\n');

    await processTranscriptOnce(input, transcript);
    expect(entries.filter(entry => entry['event.name'] === 'llm.response')).toHaveLength(0);

    const checkpointAfterA = transcriptCheckpoint(stateStore, transcript) as {
      activeTurn?: { startOffset?: number };
    };
    expect(checkpointAfterA.activeTurn?.startOffset).toBeLessThan(Buffer.byteLength(firstWave.join('\n') + '\n'));

    const secondWave = [
      record('2026-06-24T06:00:06.000Z', 'event_msg', {
        type: 'agent_message', message: 'B', phase: 'commentary',
      }),
      record('2026-06-24T06:00:07.000Z', 'response_item', {
        type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'exec_command', arguments: '{"cmd":"pwd"}',
      }),
      record('2026-06-24T06:00:08.000Z', 'response_item', {
        type: 'function_call_output', call_id: 'call-1', output: '"/tmp"',
      }),
      // Deliberately identical to wave A: equal token values are not a cross-wave dedupe key.
      record('2026-06-24T06:00:09.000Z', 'event_msg', tokenUsage(10, 2)),
    ];
    await fs.appendFile(transcript, secondWave.join('\n') + '\n', 'utf8');
    await processTranscriptOnce(input, transcript);

    expect(entries.filter(entry => entry['event.name'] === 'llm.response').map(entry => ({
      stepId: entry['gen_ai.step.id'],
      totalTokens: entry['gen_ai.usage.total_tokens'],
      finishReasons: entry['gen_ai.response.finish_reasons'],
    }))).toEqual([
      { stepId: 'session-1:turn-1:s1', totalTokens: 12, finishReasons: ['stop'] },
      { stepId: 'session-1:turn-1:s2', totalTokens: 12, finishReasons: ['tool_call'] },
    ]);
    expect(entries.filter(entry => entry['event.name'] === 'tool.call')).toHaveLength(1);
    expect(entries.filter(entry => entry['event.name'] === 'tool.result')).toHaveLength(1);

    const finalWave = [
      record('2026-06-24T06:00:10.000Z', 'event_msg', {
        type: 'agent_message', message: 'C', phase: 'final',
      }),
      record('2026-06-24T06:00:11.000Z', 'event_msg', tokenUsage(20, 3)),
    ];
    await fs.appendFile(transcript, finalWave.join('\n') + '\n', 'utf8');
    await processTranscriptOnce(input, transcript);
    expect(entries.filter(entry => entry['event.name'] === 'llm.response')).toHaveLength(2);

    await fs.appendFile(transcript, record('2026-06-24T06:00:12.000Z', 'event_msg', {
      type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'C',
    }) + '\n', 'utf8');
    await processTranscriptOnce(input, transcript);
    await input.stop();

    const responses = entries.filter(entry => entry['event.name'] === 'llm.response');
    expect(responses.map(entry => entry['gen_ai.step.id'])).toEqual([
      'session-1:turn-1:s1',
      'session-1:turn-1:s2',
      'session-1:turn-1:s3',
    ]);
    expect(responses[2]).toMatchObject({
      'gen_ai.response.finish_reasons': ['stop'],
      'gen_ai.usage.total_tokens': 23,
      'gen_ai.output.messages': [{
        role: 'assistant',
        parts: [{ type: 'text', content: 'C' }],
        finish_reason: 'stop',
      }],
    });
    const finalRequest = entries.find(entry => (
      entry['event.name'] === 'llm.request'
      && entry['gen_ai.step.id'] === 'session-1:turn-1:s3'
    ));
    expect(finalRequest?.['gen_ai.input.messages_delta']).toEqual([
      {
        role: 'assistant',
        parts: [{
          type: 'tool_call', id: 'call-1', name: 'exec_command', arguments: { command: 'pwd' },
        }],
      },
      {
        role: 'tool',
        parts: [{ type: 'tool_call_response', id: 'call-1', response: '/tmp' }],
      },
    ]);
    expect(finalRequest?.['gen_ai.input.messages']).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'run it' }] },
      ...(finalRequest?.['gen_ai.input.messages_delta'] as JsonValue[]),
    ]);
  });

  it('does not commit a tool wave until an output written after token_count is present', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-token-before-tool-output-'));
    tempDirs.push(root);
    const { input, entries, sessionDir } = await createInput(root, 60_000);
    const initial = [
      record('2026-06-24T06:00:00.000Z', 'session_meta', { id: 'session-1', model_provider: 'openai' }),
      record('2026-06-24T06:00:01.000Z', 'turn_context', { turn_id: 'turn-1', model: 'gpt-5.5' }),
      record('2026-06-24T06:00:02.000Z', 'event_msg', { type: 'task_started', turn_id: 'turn-1' }),
      record('2026-06-24T06:00:03.000Z', 'response_item', {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: 'inspect' }],
      }),
      record('2026-06-24T06:00:04.000Z', 'response_item', {
        type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'exec_command', arguments: '{"cmd":"pwd"}',
      }),
      record('2026-06-24T06:00:05.000Z', 'event_msg', tokenUsage(30, 4)),
    ];
    const transcript = await writeTranscript(sessionDir, initial.join('\n') + '\n');

    await processTranscriptOnce(input, transcript);
    expect(entries.some(entry => entry['event.name'] === 'llm.response')).toBe(false);
    expect(entries.some(entry => entry['event.name'] === 'tool.call')).toBe(false);

    await fs.appendFile(transcript, record('2026-06-24T06:00:06.000Z', 'response_item', {
      type: 'function_call_output', call_id: 'call-1', output: '"/tmp"',
    }) + '\n', 'utf8');
    await processTranscriptOnce(input, transcript);
    await input.stop();

    expect(entries.filter(entry => entry['event.name'] === 'llm.response')).toHaveLength(1);
    expect(entries.filter(entry => entry['event.name'] === 'tool.call')).toHaveLength(1);
    expect(entries.filter(entry => entry['event.name'] === 'tool.result')).toHaveLength(1);
    expect(entries.find(entry => entry['event.name'] === 'tool.result')).toMatchObject({
      'gen_ai.tool.call.id': 'call-1',
      'gen_ai.tool.call.result': '/tmp',
    });
  });

  it('retains an incomplete suffix after a closed wave and recovers it after restart', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-partial-suffix-'));
    tempDirs.push(root);
    const first = await createInput(root);
    const lines = completedTurn().trimEnd().split('\n');
    const call2Index = lines.findIndex(line => line.includes('"call_id":"call-2"'));
    const transcript = await writeTranscript(first.sessionDir, lines.slice(0, call2Index + 1).join('\n') + '\n');

    await waitFor(() => first.entries.filter(entry => entry['event.name'] === 'llm.response').length === 1);
    await first.input.stop();

    await fs.appendFile(transcript, lines.slice(call2Index + 1).join('\n') + '\n', 'utf8');
    const restarted = await createInput(root);
    await waitFor(() => restarted.entries.some(entry => entry['gen_ai.response.finish_reasons']?.includes('stop')));
    await restarted.input.stop();

    const responses = [...first.entries, ...restarted.entries]
      .filter(entry => entry['event.name'] === 'llm.response');
    expect(responses.map(entry => entry['gen_ai.step.id'])).toEqual([
      'session-1:turn-1:s1',
      'session-1:turn-1:s2',
      'session-1:turn-1:s3',
    ]);
    expect(responses.map(entry => entry['gen_ai.usage.total_tokens'])).toEqual([110, 132, 143]);
    expect([...first.entries, ...restarted.entries]
      .filter(entry => entry['event.name'] === 'tool.call')
      .map(entry => entry['gen_ai.tool.call.id'])).toEqual(['call-1', 'call-2']);

    const secondRequest = restarted.entries.find(entry => entry['gen_ai.step.id'] === 'session-1:turn-1:s2'
      && entry['event.name'] === 'llm.request')!;
    expect(secondRequest['gen_ai.input.messages_delta']).toEqual([
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
    expect(secondRequest['gen_ai.input.messages']).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'fix it' }] },
      ...(secondRequest['gen_ai.input.messages_delta'] as JsonValue[]),
    ]);
    expect(secondRequest).toMatchObject({
      'gen_ai.request.model': 'gpt-5.5',
      'agent.codex.cwd': '/tmp/project',
      'gen_ai.system_instructions': [{ type: 'text', content: 'Follow the project conventions.' }],
      'gen_ai.tool.definitions': [{ name: 'exec_command', description: 'Run a command' }],
    });
    const secondResponse = restarted.entries.find(entry => entry['gen_ai.step.id'] === 'session-1:turn-1:s2'
      && entry['event.name'] === 'llm.response');
    expect(secondResponse).toMatchObject({
      'gen_ai.response.model': 'gpt-5.5',
      'agent.codex.cwd': '/tmp/project',
    });
    expect(secondResponse?.['gen_ai.system_instructions']).toBeUndefined();
    expect(secondResponse?.['gen_ai.tool.definitions']).toBeUndefined();
  });

  it('rebuilds an oversized persisted delta from transcript offsets', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-large-persisted-delta-'));
    tempDirs.push(root);
    const first = await createInput(root);
    const largeToolOutput = 'x'.repeat(1024 * 1024 + 1);
    const lines = completedTurnWithLargeToolOutput(largeToolOutput).trimEnd().split('\n');
    const firstTokenIndex = lines.findIndex(line => line.includes('"type":"token_count"'));
    const transcript = await writeTranscript(first.sessionDir, lines.slice(0, firstTokenIndex + 1).join('\n') + '\n');

    await waitFor(() => first.entries.some(entry => entry['event.name'] === 'llm.response'));
    await first.input.stop();
    const stateStat = await fs.stat(path.join(root, 'input-state.json'));
    expect(stateStat.size).toBeLessThan(128 * 1024);

    await fs.appendFile(transcript, lines.slice(firstTokenIndex + 1).join('\n') + '\n', 'utf8');
    const restarted = await createInput(root);
    await waitFor(() => restarted.entries.some(entry => entry['gen_ai.response.finish_reasons']?.includes('stop')));
    await restarted.input.stop();

    const request = restarted.entries.find(entry => entry['event.name'] === 'llm.request')!;
    const delta = request['gen_ai.input.messages_delta'] as Array<Record<string, unknown>>;
    expect(delta.map(message => message.role)).toEqual(['assistant', 'tool']);
    expect(JSON.stringify(delta)).toContain(largeToolOutput);
    expect(request['gen_ai.input.messages']).toEqual(delta);
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
