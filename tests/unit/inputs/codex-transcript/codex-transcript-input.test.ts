import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_RESOURCE_ENV_FIELD_MAP } from '../../../../assets/hooks/shared/resource-context.mjs';
import { AgentDiscoveryService } from '../../../../src/core/agent-discovery-service.js';
import { WorkspacePolicy } from '../../../../src/core/workspace-policy.js';
import { StateStore } from '../../../../src/checkpoints/state-store.js';
import { extractCodexTranscriptMeta, extractCodexPartialTurn } from '../../../../src/inputs/codex-transcript/codex-transcript-extractor.js';
import { buildCodexTranscriptSegment } from '../../../../src/inputs/codex-transcript/codex-transcript-builder.js';
import {
  CodexTranscriptInput,
  codexDefaultAllowedRootPaths,
} from '../../../../src/inputs/codex-transcript/codex-transcript-input.js';
import {
  InputRuntimeAccumulator,
  type InputRuntimeDelta,
} from '../../../../src/inputs/base/input-runtime-metrics.js';
import { MAX_MULTIMODAL_PARTS } from '../../../../src/multimodal/types.js';
import type { BlobToUriFn } from '../../../../src/multimodal/types.js';
import { fakeBlobToUri } from '../../multimodal/fake-uri.js';
import type { AgentActivityEntry, JsonValue } from '../../../../src/types/index.js';
import type { CodexTranscriptCheckpoint, CodexTranscriptMeta } from '../../../../src/inputs/codex-transcript/codex-transcript-types.js';

const tempDirs: string[] = [];
const SUBAGENT_FIXTURE_DIR = path.resolve(process.cwd(), 'tests/fixtures/codex-subagent');
const PARENT_FIXTURE_NAME = 'rollout-2026-08-07T10-00-00-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl';
const CHILD_FIXTURE_NAME = 'rollout-2026-08-07T10-00-04-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl';
const CHILD_FIXTURES = [
  { name: CHILD_FIXTURE_NAME, threadId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', turnId: 'child-turn-1' },
  { name: 'rollout-2026-08-07T10-00-05-cccccccc-cccc-4ccc-8ccc-cccccccccccc.jsonl', threadId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', turnId: 'child-turn-2' },
  { name: 'rollout-2026-08-07T10-00-06-dddddddd-dddd-4ddd-8ddd-dddddddddddd.jsonl', threadId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', turnId: 'child-turn-3' },
  { name: 'rollout-2026-08-07T10-00-07-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.jsonl', threadId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', turnId: 'child-turn-4' },
] as const;

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

function uuidV7At(timestamp: string, tail = '000000000001'): string {
  const hex = Date.parse(timestamp).toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8)}-7000-8000-${tail}`;
}

function tokenUsage(input: number, output: number, cumulativeTotal?: number): Record<string, unknown> {
  return {
    type: 'token_count',
    info: {
      ...(cumulativeTotal !== undefined
        ? { total_token_usage: { total_tokens: cumulativeTotal } }
        : {}),
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

async function createInput(
  root: string,
  pollIntervalMs = 10,
): Promise<{
  input: CodexTranscriptInput;
  entries: AgentActivityEntry[];
  batches: AgentActivityEntry[][];
  sessionDir: string;
  wakeupDir: string;
  spanContextDir: string;
  stateStore: StateStore;
}> {
  const stateStore = new StateStore(path.join(root, 'input-state.json'));
  await stateStore.load();
  const sessionDir = path.join(root, 'sessions');
  const wakeupDir = path.join(root, 'wakeups');
  const spanContextDir = path.join(root, 'span-contexts');
  const input = new CodexTranscriptInput({
    stateStore,
    sessionDir,
    wakeupDir,
    spanContextDir,
    pollIntervalMs,
  });
  const entries: AgentActivityEntry[] = [];
  const batches: AgentActivityEntry[][] = [];
  input.on('entries', batch => {
    batches.push([...batch]);
    entries.push(...batch);
  });
  await input.start();
  return { input, entries, batches, sessionDir, wakeupDir, spanContextDir, stateStore };
}

async function createDormantInput(root: string): Promise<{
  input: CodexTranscriptInput;
  entries: AgentActivityEntry[];
  batches: AgentActivityEntry[][];
  sessionDir: string;
  wakeupDir: string;
  spanContextDir: string;
  stateStore: StateStore;
}> {
  const stateStore = new StateStore(path.join(root, 'input-state.json'));
  await stateStore.load();
  const sessionDir = path.join(root, 'sessions');
  const wakeupDir = path.join(root, 'wakeups');
  const spanContextDir = path.join(root, 'span-contexts');
  const input = new CodexTranscriptInput({
    stateStore,
    sessionDir,
    wakeupDir,
    spanContextDir,
    pollIntervalMs: 60_000,
  });
  const entries: AgentActivityEntry[] = [];
  const batches: AgentActivityEntry[][] = [];
  input.on('entries', batch => {
    batches.push([...batch]);
    entries.push(...batch);
  });
  return { input, entries, batches, sessionDir, wakeupDir, spanContextDir, stateStore };
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

async function writeSpanContext(
  spanContextDir: string,
  sessionId: string,
  turnId: string,
  payload: Record<string, unknown>,
): Promise<string> {
  await fs.mkdir(spanContextDir, { recursive: true });
  const marker = path.join(spanContextDir, `${sessionId}--${turnId}.json`);
  await fs.writeFile(marker, JSON.stringify(payload), 'utf8');
  return marker;
}

async function writeTranscriptNamed(
  sessionDir: string,
  name: string,
  text: string,
  options: { bootstrapFork?: boolean } = {},
): Promise<string> {
  const transcript = path.join(sessionDir, '2026', '06', '24', name);
  await fs.mkdir(path.dirname(transcript), { recursive: true });
  await fs.writeFile(transcript, text, 'utf8');
  // Most fixture rollouts are already terminal when written. Mirror the
  // corresponding Stop/SubagentStop marker so unrelated parser/linker tests
  // exercise normal collection after the production fork bootstrap.
  if (options.bootstrapFork !== false) {
    const records = text.trimEnd().split('\n').flatMap(line => {
      try {
        return [JSON.parse(line) as { type?: string; payload?: Record<string, unknown> }];
      } catch {
        return [];
      }
    });
    const owner = records[0];
    const ownerId = owner?.type === 'session_meta' && typeof owner.payload?.id === 'string'
      ? owner.payload.id
      : undefined;
    const isFork = typeof owner?.payload?.forked_from_id === 'string'
      || owner?.payload?.thread_source === 'subagent'
      || owner?.payload?.source !== undefined;
    const ownedTurnId = records.flatMap(item => (
      item.type === 'event_msg'
      && item.payload?.type === 'task_started'
      && typeof item.payload.turn_id === 'string'
        ? [item.payload.turn_id]
        : []
    )).at(-1);
    if (ownerId && isFork && ownedTurnId) {
      await writeWakeupMarker(path.join(path.dirname(sessionDir), 'wakeups'), ownerId, {
        session_id: ownerId,
        turn_id: ownedTurnId,
        initial_turn_id: ownedTurnId,
        transcript_path: transcript,
        hook_event: owner?.payload?.thread_source === 'subagent' ? 'subagent-stop' : 'stop',
        received_at: new Date().toISOString(),
      });
    }
  }
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

async function runInputCycle(input: CodexTranscriptInput): Promise<void> {
  await (input as unknown as { runCycle(): Promise<void> }).runCycle();
}

function transcriptCheckpoint(
  stateStore: StateStore,
  transcript: string,
): Record<string, unknown> {
  return stateStore.get(`codex-transcript:${transcript}`).extra?.codexTranscript as Record<string, unknown>;
}

describe('CodexTranscriptInput', () => {
  it('does not reread static tails, scans only appended bytes, and preserves split UTF-8 on completion', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-tail-continuation-'));
    tempDirs.push(root);
    const { input, sessionDir, entries, stateStore } = await createDormantInput(root);
    const output = 'x'.repeat(32 * 1024 * 1024) + '界';
    const lines = completedTurnWithLargeToolOutput(output).trimEnd().split('\n');
    const prefix = lines.slice(0, 5).join('\n') + '\n';
    const body = Buffer.from(lines[5]!);
    const split = body.indexOf(Buffer.from('界')) + 1;
    const transcript = await writeTranscript(sessionDir, prefix);
    await fs.appendFile(transcript, body.subarray(0, split));
    await processTranscriptOnce(input, transcript);
    await processTranscriptOnce(input, transcript);
    const start = Buffer.byteLength(prefix);
    expect(transcriptCheckpoint(stateStore, transcript).scanOffset).toBe(start);
    const measure = async (): Promise<number> => {
      const runtime = new InputRuntimeAccumulator();
      (input as unknown as { activeRuntimeAccumulator: InputRuntimeAccumulator }).activeRuntimeAccumulator = runtime;
      await processTranscriptOnce(input, transcript);
      return runtime.finish(0).rawReadBytes;
    };
    for (let i = 0; i < 5; i++) expect(await measure()).toBe(0);
    // Finish the multibyte character and JSON body without publishing LF.
    await fs.appendFile(transcript, body.subarray(split));
    expect(await measure()).toBeLessThanOrEqual(64 + body.length - split);
    expect(await measure()).toBe(0);
    await fs.appendFile(transcript, '\t');
    expect(await measure()).toBeLessThanOrEqual(65);
    expect(await measure()).toBe(0);
    // Large nonterminal appends retain a physical cursor across scan budgets.
    await fs.appendFile(transcript, Buffer.alloc(17 * 1024 * 1024, 0x20));
    expect(await measure()).toBeLessThanOrEqual(16 * 1024 * 1024 + 64);
    expect(await measure()).toBeLessThanOrEqual(1024 * 1024 + 64);
    expect(await measure()).toBe(0);
    expect(transcriptCheckpoint(stateStore, transcript).scanOffset).toBe(start);
    await stateStore.save();
    const restarted = await createDormantInput(root);
    await processTranscriptOnce(restarted.input, transcript);
    expect(transcriptCheckpoint(restarted.stateStore, transcript).scanOffset).toBe(start);
    expect(restarted.entries).toEqual([]);
    await fs.appendFile(transcript, '\n' + lines.slice(6).join('\n') + '\n');
    for (let i = 0; i < 3; i++) await processTranscriptOnce(restarted.input, transcript);
    expect(transcriptCheckpoint(restarted.stateStore, transcript)).toMatchObject({
      scanOffset: (await fs.stat(transcript)).size, activeTurn: null, pendingTerminal: null,
    });
    const results = [...entries, ...restarted.entries].filter(e => e['event.name'] === 'tool.result');
    expect(results).toHaveLength(1);
    expect(JSON.stringify(results[0])).toContain(output);
    expect(new Set([...entries, ...restarted.entries].map(e => e['event.id'])).size)
      .toBe(entries.length + restarted.entries.length);
  });

  it.each(['same-size', 'shorter', 'regrown', 'new-inode'] as const)('invalidates an incomplete-tail hint after %s replacement', async kind => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-tail-replacement-'));
    tempDirs.push(root);
    const { input, sessionDir, stateStore } = await createDormantInput(root);
    const prefix = completedTurn();
    const partial = '{"padding":"' + 'x'.repeat(1024);
    const transcript = await writeTranscript(sessionDir, prefix + partial);
    await processTranscriptOnce(input, transcript);
    await processTranscriptOnce(input, transcript);
    expect(transcriptCheckpoint(stateStore, transcript).scanOffset).toBe(Buffer.byteLength(prefix));
    const oldStat = await fs.stat(transcript);
    const length = kind === 'same-size' ? partial.length : kind === 'shorter' ? 128 : partial.length + 256;
    const replacement = JSON.stringify({ padding: 'y'.repeat(length - 15) }) + '\n';
    expect(Buffer.byteLength(replacement)).toBe(length);
    if (kind === 'new-inode') {
      await fs.writeFile(transcript + '.replacement', prefix + replacement);
      await fs.rename(transcript + '.replacement', transcript);
    } else {
      await fs.writeFile(transcript, prefix + replacement);
    }
    // Force a distinct modification time even on filesystems with coarse clocks.
    await fs.utimes(transcript, oldStat.atime, new Date(oldStat.mtimeMs + 1000));
    await processTranscriptOnce(input, transcript);
    expect(transcriptCheckpoint(stateStore, transcript).scanOffset).toBe((await fs.stat(transcript)).size);
  });

  it('quarantines a completed oversized record, preserves its incomplete tail, and resumes after restart', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-oversized-record-'));
    tempDirs.push(root);
    const { input, sessionDir, entries, stateStore } = await createDormantInput(root);
    const lines = completedTurn().trimEnd().split('\n');
    const prefix = lines.slice(0, 6).join('\n') + '\n';
    const transcript = await writeTranscript(sessionDir, prefix);
    const giantStart = Buffer.byteLength(prefix);
    const handle = await fs.open(transcript, 'a');
    try {
      await handle.write('{"type":"event_msg","payload":{"type":"item_completed","padding":"');
      const chunk = Buffer.alloc(1024 * 1024, 0x78);
      for (let i = 0; i < 129; i++) await handle.write(chunk);
      await handle.write('"}}');
    } finally {
      await handle.close();
    }
    // No newline: even an over-limit tail must not become committed input.
    await processTranscriptOnce(input, transcript);
    await processTranscriptOnce(input, transcript);
    expect(transcriptCheckpoint(stateStore, transcript).scanOffset).toBe(giantStart);

    await fs.appendFile(transcript, '\n' + lines.slice(6).join('\n') + '\n');
    const size = (await fs.stat(transcript)).size;
    const runtime = new InputRuntimeAccumulator();
    (input as unknown as { activeRuntimeAccumulator: InputRuntimeAccumulator }).activeRuntimeAccumulator = runtime;
    for (let i = 0; i < 4 && transcriptCheckpoint(stateStore, transcript).scanOffset !== size; i++) {
      await processTranscriptOnce(input, transcript);
    }
    expect(transcriptCheckpoint(stateStore, transcript)).toMatchObject({
      scanOffset: size, activeTurn: null, pendingTerminal: null,
    });
    expect(runtime.finish(0).parseFailedRecords).toBe(1);
    expect(entries.some(entry => entry['event.name'] === 'tool.result')).toBe(true);
    const baselineRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-oversized-control-'));
    tempDirs.push(baselineRoot);
    const baseline = await createDormantInput(baselineRoot);
    const control = await writeTranscript(baseline.sessionDir, completedTurn());
    await processTranscriptOnce(baseline.input, control);
    // Only the ignored FileChange diagnostic is quarantined. Audit events,
    // token accounting and terminal completion must match the small control.
    expect(entries.map(entry => [entry['event.name'], entry['gen_ai.usage.input_tokens'], entry['gen_ai.usage.output_tokens']]))
      .toEqual(baseline.entries.map(entry => [entry['event.name'], entry['gen_ai.usage.input_tokens'], entry['gen_ai.usage.output_tokens']]));

    await stateStore.save();
    const restarted = await createDormantInput(root);
    const idleRuntime = new InputRuntimeAccumulator();
    (restarted.input as unknown as { activeRuntimeAccumulator: InputRuntimeAccumulator }).activeRuntimeAccumulator = idleRuntime;
    await processTranscriptOnce(restarted.input, transcript);
    expect(idleRuntime.finish(0).rawReadBytes).toBe(0);
    expect(restarted.entries).toEqual([]);
    // The native source remains intact for explicit offline recovery.
    expect((await fs.stat(transcript)).size).toBe(size);
  });

  it('still parses complete records larger than the scan budget with linear buffer assembly', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-large-record-linear-'));
    tempDirs.push(root);
    const { input, sessionDir, stateStore, entries } = await createDormantInput(root);
    const output = '界'.repeat(6 * 1024 * 1024);
    const transcript = await writeTranscript(sessionDir, completedTurnWithLargeToolOutput(output));
    const concat = vi.spyOn(Buffer, 'concat');
    try {
      for (let i = 0; i < 4; i++) await processTranscriptOnce(input, transcript);
      expect(transcriptCheckpoint(stateStore, transcript)).toMatchObject({
        scanOffset: (await fs.stat(transcript)).size, activeTurn: null, pendingTerminal: null,
      });
      const result = entries.find(entry => entry['event.name'] === 'tool.result');
      expect(JSON.stringify(result)).toContain(output);
      // Count concatenated byte volume, not timing: catches per-chunk prefix
      // copying deterministically while allowing bounded recovery rereads.
      const copied = concat.mock.calls.reduce((sum, [buffers]) => sum + buffers.reduce((n, b) => n + b.length, 0), 0);
      expect(copied).toBeLessThan(5 * (await fs.stat(transcript)).size);
    } finally {
      concat.mockRestore();
    }
  });

  it('becomes available from a wakeup marker when the default session root is absent', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-marker-availability-'));
    tempDirs.push(root);
    const wakeupDir = path.join(root, 'wakeups');
    const absentSessionDir = path.join(root, 'absent-sessions');
    await fs.mkdir(wakeupDir, { recursive: true });

    const isolatedSessionDir = path.join(root, 'codex-home', 'u', 'fixture-user', 'sessions');
    await fs.mkdir(isolatedSessionDir, { recursive: true });
    expect(await CodexTranscriptInput.checkAvailability(wakeupDir, absentSessionDir)).toBe(false);
    await writeWakeupMarker(wakeupDir, 'session-1', {
      session_id: 'session-1',
      session_dir: isolatedSessionDir,
      received_at: new Date().toISOString(),
    });
    expect(await CodexTranscriptInput.checkAvailability(wakeupDir, absentSessionDir)).toBe(true);
    expect(CodexTranscriptInput.getWatchPaths(wakeupDir, absentSessionDir)).toEqual([
      absentSessionDir,
      wakeupDir,
    ]);
  });

  it.each(['expired', 'malformed', 'missing-timestamp', 'unsupported-layout', 'missing-root'])(
    'keeps discovery idle for a %s wakeup marker with no default sessions', async kind => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-invalid-wakeup-'));
      tempDirs.push(root);
      const sessionDir = path.join(root, 'absent-sessions');
      const wakeupDir = path.join(root, 'wakeups');
      const home = path.join(root, 'codex-home');
      const isolated = path.join(home, kind === 'unsupported-layout' ? 'other' : 'u', 'fixture', 'sessions');
      await fs.mkdir(wakeupDir, { recursive: true });
      if (kind !== 'missing-root') await fs.mkdir(isolated, { recursive: true });
      const payload = {
        codex_home: home,
        session_dir: isolated,
        received_at: kind === 'missing-timestamp' ? undefined
          : new Date(Date.now() - (kind === 'expired' ? 49 * 3600_000 : 0)).toISOString(),
      };
      await fs.writeFile(path.join(wakeupDir, 'invalid.json'), kind === 'malformed' ? '{' : JSON.stringify(payload));
      const input = new CodexTranscriptInput({
        stateStore: new StateStore(path.join(root, 'state.json')),
        sessionDir, wakeupDir, spanContextDir: path.join(root, 'contexts'),
      });
      const start = vi.spyOn(input, 'start');
      const svc = new AgentDiscoveryService([{
        id: input.id, type: input.collectionMethod,
        watchPaths: CodexTranscriptInput.getWatchPaths(wakeupDir, sessionDir),
        isAvailable: () => CodexTranscriptInput.checkAvailability(wakeupDir, sessionDir),
        start: () => input.start(), stop: () => input.stop(),
      }]);
      try {
        await svc.start();
        expect(svc.getStates()[input.id]).toBe('idle');
        expect(start).not.toHaveBeenCalled();
        expect(input.running).toBe(false);
        expect((input as unknown as { timer: unknown }).timer).toBeNull();
        expect((input as unknown as { wakeupWatcher: unknown }).wakeupWatcher).toBeNull();
      } finally {
        await svc.stop();
      }
    },
  );

  it('closes the actual wakeup watcher when stopped during Codex initialization', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-stop-during-start-'));
    tempDirs.push(root);
    const { input } = await createDormantInput(root);
    let entered!: () => void;
    let release!: () => void;
    const entering = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const internal = input as unknown as {
      indexDiscoveredTranscriptOwners(files: unknown[]): Promise<void>;
      wakeupWatcher: unknown;
      timer: unknown;
    };
    vi.spyOn(internal, 'indexDiscoveredTranscriptOwners').mockImplementation(async () => {
      entered();
      await gate;
    });
    const cycles = vi.fn();
    input.on('input-runtime-delta', cycles);
    const starting = input.start();
    await entering;
    const stopping = input.stop();
    release();
    await Promise.all([starting, stopping]);
    expect(input.running).toBe(false);
    expect(internal.wakeupWatcher).toBeNull();
    expect(internal.timer).toBeNull();
    expect(cycles).not.toHaveBeenCalled();
  });

  it.each([33, 64, 65])('prioritizes isolated rollouts globally across %i dual-layout homes', async count => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-global-root-budget-'));
    tempDirs.push(root);
    const { input, wakeupDir, sessionDir } = await createDormantInput(root);
    await fs.mkdir(sessionDir, { recursive: true });
    const canonicalRoots: string[] = [];
    for (let index = 0; index < count; index++) {
      const home = path.join(root, `home-${index}`);
      const legacy = path.join(home, 'sessions');
      const isolated = path.join(home, 'u', 'fixture-user', 'sessions');
      await fs.mkdir(legacy, { recursive: true });
      const transcript = await writeTranscript(isolated, completedTurn());
      canonicalRoots.push(await fs.realpath(isolated));
      await writeWakeupMarker(wakeupDir, String(index).padStart(3, '0'), {
        codex_home: home, session_dir: legacy, transcript_path: transcript,
        received_at: new Date().toISOString(),
      });
    }
    const internal = input as unknown as {
      discoverDynamicSessionDirs(defaultDir: string): Promise<string[]>;
      discoverSessionFiles(): Promise<Array<{ filePath: string }>>;
      logger: { warn: (...args: unknown[]) => void };
    };
    const warn = vi.spyOn(internal.logger, 'warn');
    const roots = await internal.discoverDynamicSessionDirs(await fs.realpath(sessionDir));
    expect(roots).toHaveLength(64);
    const isolatedRoots = roots.filter(dir => dir.includes(`${path.sep}u${path.sep}`));
    expect(isolatedRoots).toEqual(canonicalRoots.reverse().slice(0, 64));
    const rollouts = await internal.discoverSessionFiles();
    expect(rollouts).toHaveLength(Math.min(count, 64));
    expect(warn).toHaveBeenCalledWith(
      'Codex dynamic session root limit reached within scanned markers',
      { dropped: count * 2 - 64, cap: 64 },
    );
    await internal.discoverDynamicSessionDirs(await fs.realpath(sessionDir));
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('reuses cached owner metadata on an unchanged idle collection cycle', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-meta-cache-idle-'));
    tempDirs.push(root);
    const { input, sessionDir } = await createDormantInput(root);
    const deltas: InputRuntimeDelta[] = [];
    input.on('input-runtime-delta', (delta: InputRuntimeDelta) => deltas.push(delta));
    await writeTranscript(sessionDir, completedTurn());

    await input.start();
    await waitFor(() => deltas.length >= 1);
    await input.stop();

    expect(deltas[0].rawReadCalls).toBe(0);
    expect(deltas[0].rawReadBytes).toBe(0);
  });

  it('does not stat cold historical rollouts on the next default cycle', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-historical-idle-'));
    tempDirs.push(root);
    const { input, sessionDir, stateStore } = await createDormantInput(root);
    const deltas: InputRuntimeDelta[] = [];
    input.on('input-runtime-delta', (delta: InputRuntimeDelta) => deltas.push(delta));
    const oldAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const oldPaths: string[] = [];
    for (let index = 0; index < 12; index++) {
      const day = String(index + 1).padStart(2, '0');
      const filePath = path.join(sessionDir, '2024', '01', day, `rollout-old-${index}.jsonl`);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, record('2024-01-01T00:00:00.000Z', 'session_meta', {
        id: `old-${index}`,
        model_provider: 'openai',
      }) + '\n', 'utf8');
      await fs.utimes(filePath, oldAt, oldAt);
      oldPaths.push(filePath);
    }
    const recent = await writeTranscript(sessionDir, completedTurn());

    await input.start();
    await waitFor(() => deltas.length >= 1);
    const coldBefore = transcriptCheckpoint(stateStore, oldPaths[0]!).scanOffset;
    const recentBefore = transcriptCheckpoint(stateStore, recent).scanOffset;
    const requestCollection = () => (
      input as unknown as { requestCollection(): void }
    ).requestCollection();
    const collectAfter = async (mutate: () => Promise<void>): Promise<InputRuntimeDelta> => {
      await mutate();
      await new Promise(resolve => setTimeout(resolve, 20));
      const mark = deltas.length;
      requestCollection();
      await waitFor(() => deltas.length > mark);
      return deltas[deltas.length - 1]!;
    };

    try {
      const coldCycle = await collectAfter(() => fs.appendFile(oldPaths[0]!, record('2024-01-01T00:00:01.000Z', 'event_msg', {
        type: 'task_started',
        turn_id: 'late-turn',
      }) + '\n', 'utf8'));
      expect(transcriptCheckpoint(stateStore, oldPaths[0]!).scanOffset).toBe(coldBefore);
      expect(coldCycle.rawReadCalls).toBe(0);

      await collectAfter(() => fs.appendFile(recent, record('2026-06-24T06:20:00.000Z', 'event_msg', {
        type: 'task_started',
        turn_id: 'turn-2',
      }) + '\n', 'utf8'));
      expect(transcriptCheckpoint(stateStore, recent).scanOffset).toBeGreaterThan(recentBefore);
      expect(transcriptCheckpoint(stateStore, oldPaths[0]!).scanOffset).toBe(coldBefore);

      const created = path.join(sessionDir, '2026', '06', '25', 'rollout-new.jsonl');
      await collectAfter(async () => {
        await fs.mkdir(path.dirname(created), { recursive: true });
        await fs.writeFile(created, record('2026-06-25T00:00:00.000Z', 'session_meta', {
          id: 'new-session',
          model_provider: 'openai',
        }) + '\n', 'utf8');
      });
      expect(transcriptCheckpoint(stateStore, created)).toBeDefined();
      expect(transcriptCheckpoint(stateStore, oldPaths[0]!).scanOffset).toBe(coldBefore);
    } finally {
      await input.stop();
    }
  });

  it('uses the actual file size as the metadata cache watermark during recovery', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-meta-cache-watermark-'));
    tempDirs.push(root);
    const { input, sessionDir } = await createDormantInput(root);
    const turnText = completedTurn();
    const originalText = turnText + record('2026-06-24T06:01:00.000Z', 'event_msg', {
      type: 'diagnostic',
      padding: 'x'.repeat(32 * 1024),
    }) + '\n';
    const transcript = await writeTranscript(sessionDir, originalText);
    const originalStat = await fs.stat(transcript);
    const firstLineEndOffset = Buffer.byteLength(turnText.split('\n')[0]!) + 1;
    const checkpoint: CodexTranscriptCheckpoint = {
      inode: originalStat.ino,
      scanOffset: Buffer.byteLength(turnText),
      activeTurn: {
        turnId: 'turn-1',
        startOffset: firstLineEndOffset,
        startedAtMs: Date.parse('2026-06-24T06:00:01.000Z'),
      },
      pendingTerminal: null,
      pendingFusion: null,
      pendingSubagent: null,
      ownerSessionMetaOffset: 0,
    };
    const internals = input as unknown as {
      recoverTurnSegment(
        filePath: string,
        checkpoint: CodexTranscriptCheckpoint,
        endOffset: number,
        terminal: boolean,
      ): Promise<unknown>;
      loadTranscriptOwnerMeta(
        filePath: string,
        inode: number,
        fileSize: number,
        ownerSessionMetaOffset: number,
        runtime: InputRuntimeAccumulator,
      ): Promise<CodexTranscriptMeta | null>;
      transcriptMetaCacheByPath: Map<string, { fileSize: number }>;
    };

    await internals.recoverTurnSegment(transcript, checkpoint, Buffer.byteLength(turnText), true);
    expect(internals.transcriptMetaCacheByPath.get(transcript)?.fileSize).toBe(originalStat.size);

    const rewrittenLines = turnText.trimEnd().split('\n');
    rewrittenLines[0] = record('2026-06-24T06:00:00.000Z', 'session_meta', {
      id: 'replacement-session',
      model_provider: 'openai',
    });
    const rewrittenText = rewrittenLines.join('\n') + '\n' + record(
      '2026-06-24T06:00:12.000Z',
      'event_msg',
      { type: 'diagnostic', padding: 'y'.repeat(8 * 1024) },
    ) + '\n';
    await fs.writeFile(transcript, rewrittenText, 'utf8');
    const rewrittenStat = await fs.stat(transcript);
    expect(rewrittenStat.ino).toBe(originalStat.ino);
    expect(rewrittenStat.size).toBeLessThan(originalStat.size);
    expect(rewrittenStat.size).toBeGreaterThanOrEqual(Buffer.byteLength(turnText));

    const runtime = new InputRuntimeAccumulator();
    const replacement = await internals.loadTranscriptOwnerMeta(
      transcript,
      rewrittenStat.ino,
      rewrittenStat.size,
      0,
      runtime,
    );
    expect(replacement?.threadId).toBe('replacement-session');
    expect(runtime.finish(0).rawReadCalls).toBeGreaterThan(0);
  });

  it('reclaims metadata only after a transcript has remained absent for the TTL', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-meta-cache-absence-'));
    tempDirs.push(root);
    const { input, sessionDir } = await createDormantInput(root);
    const transcript = await writeTranscriptNamed(
      sessionDir,
      'rollout-meta-cache-absence.jsonl',
      record('2026-06-24T06:00:00.000Z', 'session_meta', {
        id: 'absence-session',
        model_provider: 'openai',
      }) + '\n',
      { bootstrapFork: false },
    );
    const internals = input as unknown as {
      indexDiscoveredTranscriptOwners(files: Array<{ filePath: string; baselineOnStart: boolean }>): Promise<void>;
      pruneAbsentTranscriptMetaCache(discoveredPaths: Set<string>, now: number): void;
      transcriptMetaCacheByPath: Map<string, { lastSeenAtMs: number }>;
    };

    await internals.indexDiscoveredTranscriptOwners([{ filePath: transcript, baselineOnStart: true }]);
    const lastSeenAtMs = internals.transcriptMetaCacheByPath.get(transcript)!.lastSeenAtMs;
    await fs.unlink(transcript);
    await internals.indexDiscoveredTranscriptOwners([]);
    expect(internals.transcriptMetaCacheByPath.has(transcript)).toBe(true);

    internals.pruneAbsentTranscriptMetaCache(new Set(), lastSeenAtMs + 48 * 60 * 60 * 1_000 + 1);
    expect(internals.transcriptMetaCacheByPath.has(transcript)).toBe(false);
  });

  it('bounds cached transcript metadata by estimated bytes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-meta-cache-bytes-'));
    tempDirs.push(root);
    const { input } = await createDormantInput(root);
    const internals = input as unknown as {
      transcriptMetaCacheMaxBytes: number;
      transcriptMetaCacheBytes: number;
      transcriptMetaCacheByPath: Map<string, unknown>;
      rememberTranscriptOwnerMeta(
        filePath: string,
        inode: number,
        fileSize: number,
        ownerSessionMetaOffset: number,
        meta: CodexTranscriptMeta,
      ): void;
    };
    internals.transcriptMetaCacheMaxBytes = 2 * 1024;
    const meta = (threadId: string): CodexTranscriptMeta => ({
      threadId,
      rootSessionId: threadId,
      threadSource: 'user',
      depth: 0,
      provider: 'openai',
      baseInstructions: 'x'.repeat(1_500),
    });

    internals.rememberTranscriptOwnerMeta('/tmp/first.jsonl', 1, 2_000, 0, meta('first'));
    internals.rememberTranscriptOwnerMeta('/tmp/second.jsonl', 2, 2_000, 0, meta('second'));

    expect(internals.transcriptMetaCacheByPath.has('/tmp/first.jsonl')).toBe(false);
    expect(internals.transcriptMetaCacheByPath.has('/tmp/second.jsonl')).toBe(true);
    expect(internals.transcriptMetaCacheBytes).toBeLessThanOrEqual(internals.transcriptMetaCacheMaxBytes);
  });

  it('keeps discovery scans from refreshing or evicting the active metadata working set', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-meta-cache-activity-'));
    tempDirs.push(root);
    const { input, sessionDir } = await createDormantInput(root);
    const writeMeta = (name: string, threadId: string) => writeTranscriptNamed(
      sessionDir,
      name,
      record('2026-06-24T06:00:00.000Z', 'session_meta', {
        id: threadId,
        model_provider: 'openai',
      }) + '\n',
      { bootstrapFork: false },
    );
    const [coldPath, hotPath, candidatePath] = await Promise.all([
      writeMeta('rollout-cache-slot-a.jsonl', 'session-0001'),
      writeMeta('rollout-cache-slot-b.jsonl', 'session-0002'),
      writeMeta('rollout-cache-slot-c.jsonl', 'session-0003'),
    ]);
    const internals = input as unknown as {
      transcriptMetaCacheMaxEntries: number;
      transcriptMetaCacheByPath: Map<string, unknown>;
      indexDiscoveredTranscriptOwners(
        files: Array<{ filePath: string; baselineOnStart: boolean }>,
      ): Promise<void>;
      loadTranscriptOwnerMeta(
        filePath: string,
        inode: number,
        fileSize: number,
        ownerSessionMetaOffset: number,
        runtime: InputRuntimeAccumulator,
        cacheAccess?: 'discovery' | 'active',
      ): Promise<CodexTranscriptMeta | null>;
    };
    const load = async (filePath: string, cacheAccess: 'discovery' | 'active') => {
      const stat = await fs.stat(filePath);
      return internals.loadTranscriptOwnerMeta(
        filePath,
        stat.ino,
        stat.size,
        0,
        new InputRuntimeAccumulator(),
        cacheAccess,
      );
    };

    await load(coldPath, 'active');
    await load(hotPath, 'active');
    internals.transcriptMetaCacheMaxEntries = 2;

    await internals.indexDiscoveredTranscriptOwners([
      { filePath: coldPath, baselineOnStart: true },
      { filePath: candidatePath, baselineOnStart: true },
    ]);
    expect([...internals.transcriptMetaCacheByPath.keys()]).toEqual([coldPath, hotPath]);

    await processTranscriptOnce(input, candidatePath);
    expect([...internals.transcriptMetaCacheByPath.keys()]).toEqual([hotPath, candidatePath]);
  });

  it('moves the metadata cache when incremental scanning finds the owning session_meta', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-meta-cache-offset-'));
    tempDirs.push(root);
    const { input, sessionDir, stateStore } = await createDormantInput(root);
    const deltas: InputRuntimeDelta[] = [];
    input.on('input-runtime-delta', (delta: InputRuntimeDelta) => deltas.push(delta));
    const ownerId = uuidV7At('2026-06-24T06:00:00.000Z');
    const copiedMeta = record('2026-06-24T06:00:00.000Z', 'session_meta', {
      id: 'copied-parent',
      model_provider: 'openai',
    }) + '\n';
    const transcript = await writeTranscriptNamed(
      sessionDir,
      `rollout-2026-06-24T06-00-00-${ownerId}.jsonl`,
      copiedMeta,
      { bootstrapFork: false },
    );

    await input.start();
    await runInputCycle(input);
    const ownerMeta = record('2026-06-24T06:00:01.000Z', 'session_meta', {
      id: ownerId,
      model_provider: 'openai',
    }) + '\n';
    await fs.appendFile(transcript, ownerMeta, 'utf8');
    await runInputCycle(input);
    await runInputCycle(input);

    expect(transcriptCheckpoint(stateStore, transcript))
      .toMatchObject({ ownerSessionMetaOffset: Buffer.byteLength(copiedMeta) });
    // Startup watcher notifications may add cycles; inspect the unchanged
    // cycle we actually drained rather than a notification-dependent index.
    expect(deltas.at(-1)!.rawReadCalls).toBe(0);
    expect(deltas.at(-1)!.rawReadBytes).toBe(0);
    await input.stop();
  });

  it('re-registers an evicted child relationship when owner metadata is served from cache', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-meta-cache-linker-'));
    tempDirs.push(root);
    const { input, sessionDir } = await createDormantInput(root);
    const fixture = await fs.readFile(path.join(SUBAGENT_FIXTURE_DIR, CHILD_FIXTURE_NAME), 'utf8');
    const transcript = await writeTranscriptNamed(
      sessionDir,
      CHILD_FIXTURE_NAME,
      fixture,
      { bootstrapFork: false },
    );
    const runtime = new InputRuntimeAccumulator();
    const internals = input as unknown as {
      getInputRuntimeAccumulator(): InputRuntimeAccumulator;
      indexDiscoveredTranscriptOwners(files: Array<{ filePath: string; baselineOnStart: boolean }>): Promise<void>;
      registerSubagentOwnerMeta(
        filePath: string,
        inode: number,
        fileSize: number,
        ownerSessionMetaOffset: number | null,
      ): Promise<void>;
      subagentLinker: { children: Map<string, unknown> };
    };
    internals.getInputRuntimeAccumulator = () => runtime;
    const discovered = [{ filePath: transcript, baselineOnStart: true }];

    await internals.indexDiscoveredTranscriptOwners(discovered);
    expect(input.getSubagentLinkSnapshot().detectedChildren).toBe(1);
    internals.subagentLinker.children.clear();
    const cachedRuntime = new InputRuntimeAccumulator();
    internals.getInputRuntimeAccumulator = () => cachedRuntime;
    const stat = await fs.stat(transcript);
    await internals.registerSubagentOwnerMeta(transcript, stat.ino, stat.size, 0);

    expect(cachedRuntime.finish(0).rawReadCalls).toBe(0);
    expect(input.getSubagentLinkSnapshot().detectedChildren).toBe(1);
  });

  it('reports physical reads separately from uniquely consumed transcript records', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-runtime-metrics-'));
    tempDirs.push(root);
    const { input, sessionDir } = await createDormantInput(root);
    const deltas: InputRuntimeDelta[] = [];
    input.on('input-runtime-delta', (delta: InputRuntimeDelta) => deltas.push(delta));

    await input.start();
    await waitFor(() => deltas.length >= 1);

    const transcriptText = completedTurn();
    const transcript = await writeTranscript(sessionDir, transcriptText);
    (input as unknown as { requestCollection(): void }).requestCollection();
    // fs.watch may also wake idle cycles; assert the consumption delta, not its index.
    await waitFor(() => deltas.some(delta => delta.rawInBytes > 0));

    const firstRead = deltas.find(delta => delta.rawInBytes > 0)!;
    const recordCount = transcriptText.trimEnd().split('\n').length;
    expect(firstRead.rawReadCalls).toBeGreaterThan(0);
    expect(firstRead.rawReadBytes).toBeGreaterThanOrEqual(firstRead.rawInBytes);
    expect(firstRead.rawInBytes).toBe(Buffer.byteLength(transcriptText));
    expect(firstRead.rawInRecords).toBe(recordCount);
    expect(firstRead.parseSuccessRecords).toBe(recordCount);
    expect(firstRead.parseFailedRecords).toBe(0);
    expect(firstRead.rawInMaxBatchBytes).toBeGreaterThan(0);
    expect(firstRead.rawInMaxRecordBytes).toBeGreaterThan(0);
    expect(firstRead.readDurationMs).toBeGreaterThanOrEqual(0);
    expect(firstRead.processDurationMs).toBeGreaterThanOrEqual(0);
    expect(firstRead).not.toHaveProperty('session_id');
    expect(firstRead).not.toHaveProperty('turn_id');
    expect(firstRead).not.toHaveProperty('trace_id');

    const invalidLine = 'not-json\n';
    await fs.appendFile(transcript, invalidLine, 'utf8');
    (input as unknown as { requestCollection(): void }).requestCollection();
    await waitFor(() => deltas.some(delta => delta.parseFailedRecords > 0));

    const invalidRead = deltas.find(delta => delta.parseFailedRecords > 0)!;
    expect(invalidRead.rawInBytes).toBe(Buffer.byteLength(invalidLine));
    expect(invalidRead.rawInRecords).toBe(1);
    expect(invalidRead.parseSuccessRecords).toBe(0);
    expect(invalidRead.parseFailedRecords).toBe(1);

    expect(deltas.reduce((total, delta) => total + delta.rawInBytes, 0))
      .toBe(Buffer.byteLength(transcriptText) + Buffer.byteLength(invalidLine));
    await input.stop();
  });

  it('extracts the single-level subagent relationship from owning session metadata', async () => {
    const fixture = await fs.readFile(path.join(SUBAGENT_FIXTURE_DIR, CHILD_FIXTURE_NAME), 'utf8');
    const firstRecord = JSON.parse(fixture.split('\n')[0]) as Record<string, unknown>;

    expect(extractCodexTranscriptMeta(firstRecord)).toEqual(expect.objectContaining({
      threadId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      rootSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      threadSource: 'subagent',
      parentThreadId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      depth: 1,
      createdAtMs: Date.parse('2026-08-07T02:00:04.100Z'),
      agentPath: '/root/fixture_child',
      agentNickname: 'FixtureChild',
      provider: 'openai',
    }));
  });

  it('bounds reported subagent link fingerprints by evicting the oldest child', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-subagent-link-cap-'));
    tempDirs.push(root);
    const { input } = await createDormantInput(root);
    const internals = input as unknown as {
      reportedSubagentLinks: Map<string, string>;
      subagentLinker: { registerChild(meta: ReturnType<typeof extractCodexTranscriptMeta>): void };
      reportSubagentLinks(): void;
    };
    for (let index = 0; index < 10_000; index++) {
      internals.reportedSubagentLinks.set(`old-child-${index}`, 'orphan::parent_not_found');
    }
    internals.subagentLinker.registerChild({
      threadId: 'new-child',
      rootSessionId: 'parent-thread',
      threadSource: 'subagent',
      parentThreadId: 'parent-thread',
      depth: 1,
      provider: 'openai',
    });

    internals.reportSubagentLinks();
    await input.stop();

    expect(internals.reportedSubagentLinks).toHaveLength(10_000);
    expect(internals.reportedSubagentLinks.has('old-child-0')).toBe(false);
    expect(internals.reportedSubagentLinks.has('new-child')).toBe(true);
  });

  it('emits completed children with their own identity before the parent terminal', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-subagent-owner-'));
    tempDirs.push(root);
    const { input, entries, sessionDir, stateStore } = await createInput(root);
    const parentFixture = await fs.readFile(path.join(SUBAGENT_FIXTURE_DIR, PARENT_FIXTURE_NAME), 'utf8');

    const parentLines = parentFixture.trimEnd().split('\n');
    const parentTerminal = parentLines.pop()!;
    const parentTranscript = await writeTranscriptNamed(
      sessionDir,
      PARENT_FIXTURE_NAME,
      parentLines.join('\n') + '\n',
    );
    await waitFor(() => input.getSubagentLinkSnapshot().detectedSpawns === 4);
    const childTranscripts = new Map<string, string>();
    for (const fixture of CHILD_FIXTURES) {
      const text = await fs.readFile(path.join(SUBAGENT_FIXTURE_DIR, fixture.name), 'utf8');
      childTranscripts.set(fixture.threadId, await writeTranscriptNamed(sessionDir, fixture.name, text));
    }
    await waitFor(() => CHILD_FIXTURES.every(fixture => responsesForTurn(entries, fixture.turnId).length === 1));
    expect(transcriptCheckpoint(stateStore, parentTranscript).activeTurn).not.toBeNull();

    await fs.appendFile(parentTranscript, parentTerminal + '\n', 'utf8');
    await waitFor(() => transcriptCheckpoint(stateStore, parentTranscript).activeTurn === null);
    await waitFor(() => CHILD_FIXTURES.every(fixture =>
      responsesForTurn(entries, fixture.turnId).length === 1));
    await input.stop();

    expect(responsesForTurn(entries, 'parent-turn-1')).toHaveLength(2);
    for (const fixture of CHILD_FIXTURES) {
      const childEntries = entries.filter(entry =>
        entry['agent.codex.transcript_turn_id'] === fixture.turnId);
      expect(childEntries.length).toBeGreaterThan(0);
      expect(new Set(childEntries.map(entry => entry['gen_ai.session.id']))).toEqual(
        new Set([fixture.threadId]),
      );
      expect(new Set(childEntries.map(entry => entry['gen_ai.agent.id']))).toEqual(
        new Set([fixture.threadId]),
      );
      expect(new Set(childEntries.map(entry => entry['gen_ai.turn.id']))).toEqual(
        new Set([`${fixture.threadId}:${fixture.turnId}`]),
      );
      expect(transcriptCheckpoint(stateStore, childTranscripts.get(fixture.threadId)!)).toMatchObject({
        ownerSessionMetaOffset: 0,
      });
      expect(childEntries.every(entry => entry['gen_ai.agent.scope'] === 'subagent')).toBe(true);
      expect(childEntries.every(entry => entry['gen_ai.agent.depth'] === 1)).toBe(true);
      expect(new Set(childEntries.map(entry => entry['gen_ai.subagent.parent_tool_call.id']))).toEqual(
        new Set([`call-subagent-${CHILD_FIXTURES.indexOf(fixture) + 1}`]),
      );
      expect(childEntries.some(entry => entry['event.name'] === 'other')).toBe(true);
      expect(childEntries.every(entry => entry['agent.codex.delegated'] === true)).toBe(true);
      expect(new Set(childEntries.flatMap(entry => typeof entry['gen_ai.step.id'] === 'string'
        ? [entry['gen_ai.step.id']] : []))).toEqual(new Set([`${fixture.threadId}:${fixture.turnId}:s1`]));
      const tool = entries.find(entry => entry['event.name'] === 'tool.call'
        && entry['gen_ai.tool.call.id'] === `call-subagent-${CHILD_FIXTURES.indexOf(fixture) + 1}`);
      expect(tool?.span_id).toMatch(/^[a-f0-9]{16}$/);
      expect(new Set(childEntries.map(entry => entry['agent.codex.parent_span_id'])))
        .toEqual(new Set([tool!.span_id]));
      const invoke = entries.find(entry => entry['event.name'] === 'gen_ai.agent.invoke'
        && entry['gen_ai.tool.call.id'] === tool!['gen_ai.tool.call.id']);
      expect(invoke).toBeDefined();
      expect(new Set(childEntries.map(entry => entry['gen_ai.agent.parent.invocation.id'])))
        .toEqual(new Set([invoke!['gen_ai.agent.invocation.id']]));
      expect(childEntries.find(entry => entry['event.name'] === 'llm.request')).toEqual(
        expect.objectContaining({
          'gen_ai.input.messages': expect.any(Array),
        }),
      );
    }
    expect(transcriptCheckpoint(stateStore, parentTranscript)).toMatchObject({
      pendingFusion: null,
      activeTurn: null,
    });
    expect(input.getSubagentLinkSnapshot()).toMatchObject({
      detectedChildren: 4,
      detectedSpawns: 4,
      linkedChildren: 4,
      orphanChildren: 0,
      links: CHILD_FIXTURES.map((fixture, index) => expect.objectContaining({
        childThreadId: fixture.threadId,
        parentThreadId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        parentTurnId: 'parent-turn-1',
        parentToolCallId: `call-subagent-${index + 1}`,
        confidence: 'agent_path',
      })),
    });
  });

  it.each([
    'collab spawn failed: agent thread limit reached',
    JSON.stringify({ status: 'rejected', reason: 'dispatch rejected' }),
  ])('records an actual failed delegation result without a child for %s', async failure => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-dispatch-failure-'));
    tempDirs.push(root);
    const { input, entries, sessionDir } = await createDormantInput(root);
    const lines = simpleCompletedTurn('session-failed', 'failed-turn', 'delegate work', 'dispatch failed', 10, 2,
      '2026-08-07T02:00:00.000Z');
    lines.splice(4, 0,
      record('2026-08-07T02:00:04.000Z', 'response_item', {
        type: 'function_call', call_id: 'failed-spawn', name: 'spawn_agent', arguments: JSON.stringify({ message: 'child work' }),
      }),
      record('2026-08-07T02:00:04.500Z', 'response_item', {
        type: 'function_call_output', call_id: 'failed-spawn', output: failure,
      }),
    );
    const transcript = await writeTranscriptNamed(sessionDir, 'rollout-session-failed.jsonl', lines.join('\n') + '\n');
    await processTranscriptOnce(input, transcript);
    const invoke = entries.filter(entry => entry['event.name'] === 'gen_ai.agent.invoke');
    const result = entries.filter(entry => entry['event.name'] === 'gen_ai.agent.result');
    expect(invoke).toHaveLength(1);
    expect(result).toHaveLength(1);
    expect(result[0]!['gen_ai.agent.invocation.id']).toBe(invoke[0]!['gen_ai.agent.invocation.id']);
    expect(result[0]!['error.type']).toBe('codex.delegation_failed');
    expect(result[0]!['gen_ai.agent.peer.id']).toBeUndefined();
    expect(result[0]!['tool.result.status']).toBeUndefined();
    expect(entries.some(entry => entry['gen_ai.agent.parent.invocation.id'])).toBe(false);
    await processTranscriptOnce(input, transcript);
    expect(entries.filter(entry => entry['event.name'] === 'gen_ai.agent.result')).toHaveLength(1);
  });

  it('collects an ordinary turn without computing global subagent relationships', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-no-global-links-'));
    tempDirs.push(root);
    const { input, entries, sessionDir } = await createDormantInput(root);
    const linker = (input as unknown as { subagentLinker: {
      snapshot(): unknown; getDelegationsForParent(parent: string): unknown;
    } }).subagentLinker;
    const snapshot = vi.spyOn(linker, 'snapshot').mockImplementation(() => { throw new Error('global relationship scan on ordinary collection'); });
    const scopedLookup = vi.spyOn(linker, 'getDelegationsForParent').mockImplementation(() => { throw new Error('result lookup without a result'); });
    const transcript = await writeTranscript(sessionDir, completedTurn());
    await processTranscriptOnce(input, transcript);
    expect(responsesForTurn(entries, 'turn-1')).toHaveLength(3);
    expect(snapshot).not.toHaveBeenCalled();
    expect(scopedLookup).not.toHaveBeenCalled();
  });

  it('audits dispatch intent before the tool acknowledgement or parent terminal', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-dispatch-boundary-'));
    tempDirs.push(root);
    const { input, entries, sessionDir } = await createDormantInput(root);
    const source = await fs.readFile(path.join(SUBAGENT_FIXTURE_DIR, PARENT_FIXTURE_NAME), 'utf8');
    const lines = source.trimEnd().split('\n');
    const acknowledgement = lines.findIndex(line => line.includes('function_call_output'));
    const transcript = await writeTranscriptNamed(sessionDir, PARENT_FIXTURE_NAME, lines.slice(0, acknowledgement).join('\n') + '\n');
    await processTranscriptOnce(input, transcript);
    const invoked = entries.filter(entry => entry['event.name'] === 'gen_ai.agent.invoke');
    expect(invoked).toHaveLength(4);
    expect(new Set(invoked.map(entry => entry['gen_ai.agent.invocation.id'])).size).toBe(4);
    for (const invoke of invoked) {
      const call = lines.map(line => JSON.parse(line)).find(source => source.payload.type === 'function_call'
        && source.payload.call_id === invoke['gen_ai.tool.call.id']);
      expect(invoke['gen_ai.input.messages']).toEqual([{
        role: 'user', parts: [{ type: 'text', content: JSON.parse(call.payload.arguments).message }],
      }]);
    }
    expect(entries.filter(entry => entry['event.name'] === 'gen_ai.agent.result')).toHaveLength(0);
    await fs.appendFile(transcript, lines.slice(acknowledgement).join('\n') + '\n', 'utf8');
    await processTranscriptOnce(input, transcript);
    expect(entries.filter(entry => entry['event.name'] === 'gen_ai.agent.invoke').map(entry => entry['event.id']))
      .toEqual(invoked.map(entry => entry['event.id']));
    expect(entries.filter(entry => entry['event.name'] === 'gen_ai.agent.result')).toHaveLength(0);
  });

  it.each([
    ['spawn_agent', { message: '  delegated task\nwith explicit context  ' }, '  delegated task\nwith explicit context  '],
    ['spawn_agent', { prompt: 'prompt work' }, 'prompt work'],
    ['spawn_agent', { input: 'input work' }, 'input work'],
    ['followup_task', { target: '/root/child', message: 'new work for reused child' }, 'new work for reused child'],
    ['send_input', { id: 'child', input: [{ type: 'text', text: 'first part' }, { type: 'text', text: 'second part' }] }, ['first part', 'second part']],
  ])('maps %s delegation content to input messages', async (name, args, expected) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-invoke-content-'));
    tempDirs.push(root);
    const { input, entries, sessionDir } = await createDormantInput(root);
    const lines = simpleCompletedTurn('invoke-parent', 'invoke-turn', 'parent context is not the task', 'done', 10, 2,
      '2026-08-07T02:00:00.000Z');
    lines.splice(4, 0, record('2026-08-07T02:00:04.000Z', 'response_item', {
      type: 'function_call', call_id: 'invoke-call', name, arguments: JSON.stringify(args),
    }));
    const transcript = await writeTranscriptNamed(sessionDir, 'rollout-invoke-parent.jsonl', lines.join('\n') + '\n');
    await processTranscriptOnce(input, transcript);
    const invoke = entries.filter(entry => entry['event.name'] === 'gen_ai.agent.invoke');
    expect(invoke).toHaveLength(1);
    expect(invoke[0]!['gen_ai.input.messages']).toEqual([{
      role: 'user', parts: (Array.isArray(expected) ? expected : [expected]).map(content => ({ type: 'text', content })),
    }]);
    expect(invoke[0]!['gen_ai.input.messages_delta']).toBeUndefined();
    expect(invoke[0]).not.toHaveProperty('gen_ai.tool.call.arguments');
    expect(entries.find(entry => entry['event.name'] === 'tool.call')!['gen_ai.tool.call.arguments']).toEqual(args);
    await processTranscriptOnce(input, transcript);
    expect(entries.filter(entry => entry['event.name'] === 'gen_ai.agent.invoke')).toEqual(invoke);
  });

  it.each(['agents', 'tasks'])('keeps %s batch invocation content separated by original work index', async batchField => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-invoke-batch-content-'));
    tempDirs.push(root);
    const { input, entries, sessionDir } = await createDormantInput(root);
    const args = { [batchField]: [{ message: 'first work' }, null, { prompt: 'third work' }], message: 'batch envelope' };
    const lines = simpleCompletedTurn('batch-parent', 'batch-turn', 'unrelated parent input', 'done', 10, 2,
      '2026-08-07T02:00:00.000Z');
    lines.splice(4, 0, record('2026-08-07T02:00:04.000Z', 'response_item', {
      type: 'function_call', call_id: 'batch-call', name: 'spawn_agent', arguments: JSON.stringify(args),
    }));
    const transcript = await writeTranscriptNamed(sessionDir, 'rollout-batch-parent.jsonl', lines.join('\n') + '\n');
    await processTranscriptOnce(input, transcript);
    const invokes = entries.filter(entry => entry['event.name'] === 'gen_ai.agent.invoke');
    expect(invokes).toHaveLength(3);
    expect(invokes.map(entry => entry['gen_ai.input.messages'])).toEqual([
      [{ role: 'user', parts: [{ type: 'text', content: 'first work' }] }],
      undefined,
      [{ role: 'user', parts: [{ type: 'text', content: 'third work' }] }],
    ]);
    expect(new Set(invokes.map(entry => entry['gen_ai.agent.invocation.id'])).size).toBe(3);
    expect(invokes.every(entry => entry['gen_ai.tool.call.arguments'] === undefined)).toBe(true);
    expect(entries.find(entry => entry['event.name'] === 'tool.call')!['gen_ai.tool.call.arguments']).toEqual(args);
  });

  it('does not attach new children to a historical spawn in a long parent rollout', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-subagent-history-'));
    tempDirs.push(root);
    const { input, sessionDir, stateStore } = await createDormantInput(root);
    const parentFixture = await fs.readFile(path.join(SUBAGENT_FIXTURE_DIR, PARENT_FIXTURE_NAME), 'utf8');
    const [sessionMeta, ...currentTurn] = parentFixture.trimEnd().split('\n');
    const historicalTurn = [
      record('2026-08-07T01:00:00.000Z', 'turn_context', {
        turn_id: 'historical-parent-turn', model: 'gpt-test', cwd: '/tmp/codex-subagent-fixture',
      }),
      record('2026-08-07T01:00:01.000Z', 'event_msg', {
        type: 'task_started', turn_id: 'historical-parent-turn',
      }),
      record('2026-08-07T01:00:02.000Z', 'response_item', {
        type: 'function_call',
        call_id: 'call-historical-subagent',
        name: 'spawn_agent',
        arguments: JSON.stringify({ task_name: 'stale_child', message: 'redacted' }),
      }),
      record('2026-08-07T01:00:03.000Z', 'response_item', {
        type: 'function_call_output',
        call_id: 'call-historical-subagent',
        output: JSON.stringify({ task_name: '/root/stale_child' }),
      }),
      record('2026-08-07T01:00:04.000Z', 'event_msg', {
        type: 'task_complete', turn_id: 'historical-parent-turn', last_agent_message: 'delegated',
      }),
    ];
    const parentTranscript = await writeTranscriptNamed(
      sessionDir,
      PARENT_FIXTURE_NAME,
      [sessionMeta, ...historicalTurn, ...currentTurn].join('\n') + '\n',
    );

    for (const fixture of CHILD_FIXTURES) {
      const text = await fs.readFile(path.join(SUBAGENT_FIXTURE_DIR, fixture.name), 'utf8');
      const childTranscript = await writeTranscriptNamed(sessionDir, fixture.name, text);
      await processTranscriptOnce(input, childTranscript);
    }
    await processTranscriptOnce(input, parentTranscript);

    expect(transcriptCheckpoint(stateStore, parentTranscript)).toMatchObject({
      pendingFusion: null,
      activeTurn: null,
    });
    expect(input.getSubagentLinkSnapshot().links).toEqual(expect.arrayContaining(
      CHILD_FIXTURES.map((fixture, index) => expect.objectContaining({
        childThreadId: fixture.threadId,
        parentTurnId: 'parent-turn-1',
        parentToolCallId: `call-subagent-${index + 1}`,
      })),
    ));
  });

  it('ends child turns independently and keeps scanning later child turns', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-subagent-child-first-'));
    tempDirs.push(root);
    const { input, entries, sessionDir, stateStore } = await createInput(root);
    const parentFixture = await fs.readFile(path.join(SUBAGENT_FIXTURE_DIR, PARENT_FIXTURE_NAME), 'utf8');
    const parentLines = parentFixture.trimEnd().split('\n');
    const parentTerminal = parentLines.pop()!;
    const parentTranscript = await writeTranscriptNamed(
      sessionDir,
      PARENT_FIXTURE_NAME,
      parentLines.join('\n') + '\n',
    );
    await waitFor(() => input.getSubagentLinkSnapshot().detectedSpawns === 4);

    const childTranscripts: string[] = [];
    for (const [index, fixture] of CHILD_FIXTURES.entries()) {
      let text = await fs.readFile(path.join(SUBAGENT_FIXTURE_DIR, fixture.name), 'utf8');
      if (index === 0) {
        const lines = text.trimEnd().split('\n');
        const terminal = JSON.parse(lines.at(-1)!) as { payload: Record<string, unknown> };
        terminal.payload.type = 'turn_aborted';
        delete terminal.payload.last_agent_message;
        terminal.payload.reason = 'interrupted';
        lines[lines.length - 1] = JSON.stringify(terminal);
        text = lines.join('\n') + '\n';
      }
      childTranscripts.push(await writeTranscriptNamed(sessionDir, fixture.name, text));
    }
    await waitFor(() => CHILD_FIXTURES.every(fixture => responsesForTurn(entries, fixture.turnId).length === 1));
    for (const [index, transcript] of childTranscripts.entries()) {
      const childStat = await fs.stat(transcript);
      expect(transcriptCheckpoint(stateStore, transcript)).toMatchObject({
        scanOffset: childStat.size,
        pendingSubagent: null,
        activeTurn: null,
      });
    }
    expect(CHILD_FIXTURES.every(fixture => responsesForTurn(entries, fixture.turnId).length === 1)).toBe(true);

    const followupLines = simpleCompletedTurn(
      CHILD_FIXTURES[0].threadId,
      'child-followup-turn',
      'direct user follow up after the child terminal',
      'followup complete',
      10,
      2,
      '2026-08-07T02:02:00.000Z',
    ).slice(1);
    await fs.appendFile(childTranscripts[0]!, followupLines.join('\n') + '\n', 'utf8');
    await waitFor(() => responsesForTurn(entries, 'child-followup-turn').length === 1);
    expect(transcriptCheckpoint(stateStore, childTranscripts[0]!).pendingSubagent).toBeNull();
    expect(responsesForTurn(entries, 'child-followup-turn')[0])
      .not.toHaveProperty('gen_ai.agent.parent.invocation.id');

    await fs.appendFile(parentTranscript, parentTerminal + '\n', 'utf8');
    await waitFor(() => CHILD_FIXTURES.every(fixture =>
      responsesForTurn(entries, fixture.turnId).length === 1));
    await input.stop();

    const abortedEntries = entries.filter(entry =>
      entry['agent.codex.transcript_turn_id'] === 'child-turn-1');
    expect(abortedEntries.some(entry => entry['agent.codex.turn_status'] === 'interrupted')).toBe(true);
    expect(abortedEntries.every(entry => entry['gen_ai.agent.scope'] === 'subagent')).toBe(true);
    expect(transcriptCheckpoint(stateStore, parentTranscript)).toMatchObject({ pendingFusion: null });
  });

  it('keeps a reliably linked child running after its parent reaches task_complete', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-subagent-parent-barrier-'));
    tempDirs.push(root);
    const { input, entries, sessionDir, wakeupDir, stateStore } = await createDormantInput(root);
    const parentFixture = await fs.readFile(path.join(SUBAGENT_FIXTURE_DIR, PARENT_FIXTURE_NAME), 'utf8');
    const parentLines = parentFixture.trimEnd().split('\n');
    const parentTerminal = parentLines.pop()!;
    const parentTranscript = await writeTranscriptNamed(
      sessionDir,
      PARENT_FIXTURE_NAME,
      parentLines.join('\n') + '\n',
    );
    await processTranscriptOnce(input, parentTranscript);

    const childFixture = await fs.readFile(path.join(SUBAGENT_FIXTURE_DIR, CHILD_FIXTURE_NAME), 'utf8');
    const childLines = childFixture.trimEnd().split('\n');
    childLines.pop();
    const childTranscript = await writeTranscriptNamed(
      sessionDir,
      CHILD_FIXTURE_NAME,
      childLines.join('\n') + '\n',
    );
    await processTranscriptOnce(input, childTranscript);

    const childStat = await fs.stat(childTranscript);
    expect(responsesForTurn(entries, 'child-turn-1')).toHaveLength(0);
    expect(transcriptCheckpoint(stateStore, childTranscript)).toMatchObject({
      scanOffset: childStat.size,
      pendingSubagent: null,
      activeTurn: {
        turnId: 'child-turn-1',
        emittedStepCount: 0,
      },
    });

    await fs.appendFile(parentTranscript, parentTerminal + '\n', 'utf8');
    await processTranscriptOnce(input, parentTranscript);
    expect(transcriptCheckpoint(stateStore, parentTranscript).pendingFusion).toBeNull();
    expect(responsesForTurn(entries, 'parent-turn-1')).toHaveLength(2);
    await runInputCycle(input);
    expect(responsesForTurn(entries, 'child-turn-1')).toHaveLength(0);
    expect(transcriptCheckpoint(stateStore, childTranscript)).toMatchObject({
      activeTurn: { turnId: 'child-turn-1' },
      pendingSubagent: null,
    });

    await fs.appendFile(childTranscript, record('2026-08-07T02:05:00.000Z', 'event_msg', {
      type: 'task_complete', turn_id: 'child-turn-1', last_agent_message: 'background complete',
    }) + '\n', 'utf8');
    await processTranscriptOnce(input, childTranscript);
    expect(responsesForTurn(entries, 'child-turn-1')).toHaveLength(1);
    expect(responsesForTurn(entries, 'child-turn-1')[0]).toMatchObject({
      'gen_ai.session.id': CHILD_FIXTURES[0].threadId,
      'gen_ai.turn.id': `${CHILD_FIXTURES[0].threadId}:child-turn-1`,
      'gen_ai.agent.scope': 'subagent',
      'gen_ai.subagent.parent_tool_call.id': 'call-subagent-1',
    });
    expect(transcriptCheckpoint(stateStore, childTranscript)).toMatchObject({
      activeTurn: null, pendingSubagent: null,
    });
    expect(transcriptCheckpoint(stateStore, parentTranscript)).toMatchObject({
      activeTurn: null, pendingFusion: null,
    });
  });

  it('emits a linked child arriving after the parent without changing its identity', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-subagent-missing-child-'));
    tempDirs.push(root);
    const { input, entries, sessionDir, wakeupDir, stateStore } = await createDormantInput(root);
    const parentFixture = await fs.readFile(path.join(SUBAGENT_FIXTURE_DIR, PARENT_FIXTURE_NAME), 'utf8');
    const parentLines = parentFixture.trimEnd().split('\n');
    const parentTerminal = parentLines.pop()!;
    const parentTranscript = await writeTranscriptNamed(
      sessionDir,
      PARENT_FIXTURE_NAME,
      parentLines.join('\n') + '\n',
    );
    await processTranscriptOnce(input, parentTranscript);

    const childFixture = await fs.readFile(path.join(SUBAGENT_FIXTURE_DIR, CHILD_FIXTURE_NAME), 'utf8');
    const childLines = childFixture.trimEnd().split('\n');
    const childTranscript = await writeTranscriptNamed(
      sessionDir,
      CHILD_FIXTURE_NAME,
      childLines[0]! + '\n',
    );
    await processTranscriptOnce(input, childTranscript);

    await fs.appendFile(parentTranscript, parentTerminal + '\n', 'utf8');
    await processTranscriptOnce(input, parentTranscript);
    expect(transcriptCheckpoint(stateStore, parentTranscript).pendingFusion).toBeNull();

    await runInputCycle(input);

    expect(responsesForTurn(entries, 'parent-turn-1')).toHaveLength(2);
    expect(transcriptCheckpoint(stateStore, parentTranscript)).toMatchObject({
      activeTurn: null,
      pendingFusion: null,
    });

    await fs.appendFile(childTranscript, childLines.slice(1).join('\n') + '\n', 'utf8');
    await writeWakeupMarker(wakeupDir, CHILD_FIXTURES[0].threadId, {
      session_id: CHILD_FIXTURES[0].threadId,
      turn_id: CHILD_FIXTURES[0].turnId,
      initial_turn_id: CHILD_FIXTURES[0].turnId,
      transcript_path: childTranscript,
      hook_event: 'subagent-stop',
    });
    await processTranscriptOnce(input, childTranscript);

    expect(responsesForTurn(entries, 'child-turn-1')).toHaveLength(1);
    expect(responsesForTurn(entries, 'child-turn-1')[0]).toMatchObject({
      'gen_ai.session.id': CHILD_FIXTURES[0].threadId,
      'gen_ai.agent.scope': 'subagent',
      'gen_ai.agent.parent.invocation.id': expect.any(String),
    });
    expect(transcriptCheckpoint(stateStore, childTranscript)).toMatchObject({
      activeTurn: null,
      pendingSubagent: null,
    });
  });

  it('emits an orphan child as an independent trace instead of holding its rollout', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-subagent-orphan-'));
    tempDirs.push(root);
    const { input, entries, sessionDir, stateStore } = await createDormantInput(root);
    const childFixture = await fs.readFile(path.join(SUBAGENT_FIXTURE_DIR, CHILD_FIXTURE_NAME), 'utf8');
    const childTranscript = await writeTranscriptNamed(sessionDir, CHILD_FIXTURE_NAME, childFixture);

    await processTranscriptOnce(input, childTranscript);

    expect(responsesForTurn(entries, 'child-turn-1')).toHaveLength(1);
    expect(responsesForTurn(entries, 'child-turn-1')[0]).toMatchObject({
      'gen_ai.session.id': CHILD_FIXTURES[0].threadId,
    });
    expect(transcriptCheckpoint(stateStore, childTranscript)).toMatchObject({
      pendingSubagent: null,
      activeTurn: null,
    });
  });

  it('collects followup_task work without waiting for parent fusion', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-subagent-followup-'));
    tempDirs.push(root);
    const { input, entries, sessionDir, stateStore } = await createDormantInput(root);
    const parentFixture = (await fs.readFile(
      path.join(SUBAGENT_FIXTURE_DIR, PARENT_FIXTURE_NAME),
      'utf8',
    )).replaceAll('"name":"spawn_agent"', '"name":"followup_task"');
    const parentTranscript = await writeTranscriptNamed(sessionDir, PARENT_FIXTURE_NAME, parentFixture);
    const childFixture = await fs.readFile(path.join(SUBAGENT_FIXTURE_DIR, CHILD_FIXTURE_NAME), 'utf8');
    const childTranscript = await writeTranscriptNamed(sessionDir, CHILD_FIXTURE_NAME, childFixture);

    await processTranscriptOnce(input, parentTranscript);
    await processTranscriptOnce(input, childTranscript);

    expect(responsesForTurn(entries, 'parent-turn-1')).toHaveLength(1);
    expect(responsesForTurn(entries, 'child-turn-1')).toHaveLength(1);
    expect(transcriptCheckpoint(stateStore, parentTranscript)).toMatchObject({ pendingFusion: null });
    expect(transcriptCheckpoint(stateStore, childTranscript)).toMatchObject({ pendingSubagent: null });
  });

  it.each([false, true])('fills an already known path-only followup peer without replaying an unknown creation (restart=%s)', async restart => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-known-dispatch-peer-'));
    tempDirs.push(root);
    const first = await createDormantInput(root);
    const parent = 'peer-parent';
    const child = 'peer-child';
    const dispatch = (turn: string, name: string, callId: string, message: string, start: string): string[] => {
      const lines = simpleCompletedTurn(parent, turn, 'delegate work', 'accepted', 10, 2, start);
      const at = Date.parse(start);
      lines.splice(4, 0,
        record(new Date(at + 3_100).toISOString(), 'response_item', { type: 'function_call', call_id: callId, name,
          arguments: JSON.stringify(name === 'spawn_agent' ? { task_name: 'known-child', message } : { target: '/root/known-child', message }) }),
        record(new Date(at + 3_200).toISOString(), 'response_item', { type: 'function_call_output', call_id: callId,
          output: JSON.stringify({ task_name: '/root/known-child', accepted: true }) }));
      return lines;
    };
    const parentPath = await writeTranscriptNamed(first.sessionDir, 'rollout-peer-parent.jsonl',
      dispatch('first-parent', 'spawn_agent', 'create-child', 'first work', '2026-08-07T03:10:00.000Z').join('\n') + '\n');
    await processTranscriptOnce(first.input, parentPath);
    const creation = first.entries.find(entry => entry['event.name'] === 'gen_ai.agent.invoke')!;
    expect(creation['gen_ai.agent.peer.id']).toBeUndefined();
    expect(creation['gen_ai.agent.peer.name']).toBeUndefined();
    const childLines = simpleCompletedTurn(child, 'first-child', 'first work', 'done', 20, 3, '2026-08-07T03:10:10.000Z');
    childLines[0] = record('2026-08-07T03:10:09.000Z', 'session_meta', { id: child, session_id: parent, thread_source: 'subagent',
      source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_path: '/root/known-child', agent_nickname: 'Newton' } } } });
    const childPath = await writeTranscriptNamed(first.sessionDir, 'rollout-peer-child.jsonl', childLines.join('\n') + '\n');
    await processTranscriptOnce(first.input, childPath);
    expect(responsesForTurn(first.entries, 'first-child')[0]!['gen_ai.agent.parent.invocation.id']).toBe(creation['gen_ai.agent.invocation.id']);
    await first.stateStore.save();
    const active = restart ? await createDormantInput(root) : first;
    await fs.appendFile(parentPath, dispatch('second-parent', 'followup_task', 'reuse-child', 'second work', '2026-08-07T03:11:00.000Z').slice(1).join('\n') + '\n');
    await processTranscriptOnce(active.input, parentPath);
    const all = restart ? [...first.entries, ...active.entries] : active.entries;
    const invokes = all.filter(entry => entry['event.name'] === 'gen_ai.agent.invoke');
    expect(invokes).toHaveLength(2);
    expect(invokes.find(entry => entry['gen_ai.tool.call.id'] === 'reuse-child')).toMatchObject({ 'gen_ai.agent.peer.id': child, 'gen_ai.agent.peer.name': 'Newton' });
    expect(invokes.find(entry => entry['gen_ai.tool.call.id'] === 'create-child')!['gen_ai.agent.peer.id']).toBeUndefined();
    const count = active.entries.length;
    await processTranscriptOnce(active.input, parentPath);
    expect(active.entries).toHaveLength(count);
  });

  it.each([false, true].flatMap(restart => ['canonical', 'legacy'].flatMap(format =>
    ['none', 'user', 'agent', 'result'].map(incoming => ({ restart, incoming, format })))))(
    'distinguishes new work from an uncommitted creation input reread (restart=$restart, incoming=$incoming, format=$format)',
    async ({ restart, incoming, format }) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-uncommitted-incoming-'));
      tempDirs.push(root);
      const first = await createDormantInput(root);
      const parent = 'uncommitted-parent';
      const child = 'uncommitted-child';
      const at = (seconds: number) => new Date(Date.parse('2026-08-07T03:20:00.000Z') + seconds * 1_000).toISOString();
      const parentLines = simpleCompletedTurn(parent, 'parent-turn', 'delegate', 'accepted', 10, 2, at(0));
      parentLines.splice(4, 0,
        record(at(3.1), 'response_item', { type: 'function_call', call_id: 'initial-spawn', name: 'spawn_agent',
          arguments: JSON.stringify({ task_name: 'child', message: 'initial delegated work' }) }),
        record(at(3.2), 'response_item', { type: 'function_call_output', call_id: 'initial-spawn', output: JSON.stringify({ agent_id: child }) }),
        record(at(3.3), 'response_item', { type: 'function_call', call_id: 'queued-followup', name: 'followup_task',
          arguments: JSON.stringify({ id: child, message: 'replacement work' }) }),
        record(at(3.4), 'response_item', { type: 'function_call_output', call_id: 'queued-followup', output: JSON.stringify({ agent_id: child }) }));
      const parentPath = await writeTranscriptNamed(first.sessionDir, 'rollout-uncommitted-parent.jsonl', parentLines.join('\n') + '\n');
      await processTranscriptOnce(first.input, parentPath);
      const invocation = first.entries.find(entry => entry['event.name'] === 'gen_ai.agent.invoke')!['gen_ai.agent.invocation.id'];
      const childLines = simpleCompletedTurn(child, 'child-turn', 'initial delegated work', 'child done', 20, 3, at(10));
      childLines[0] = record(at(10), 'session_meta', { id: child, session_id: parent, thread_source: 'subagent',
        source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_path: '/root/child' } } } });
      if (format === 'legacy') childLines[3] = record(at(13), 'event_msg', {
        type: 'user_message', message: 'initial delegated work',
      });
      const childPath = await writeTranscriptNamed(first.sessionDir, 'rollout-uncommitted-child.jsonl', childLines.slice(0, 4).join('\n') + '\n');
      await processTranscriptOnce(first.input, childPath);
      expect(transcriptCheckpoint(first.stateStore, childPath).activeTurn).toMatchObject({
        emittedStepCount: 0, delegation: { invocationId: invocation },
      });
      // A growing rollout rereads the original ordinary user input until the first wave closes.
      await fs.appendFile(childPath, record(at(13.1), 'response_item', { type: 'message', role: 'developer',
        content: [{ type: 'input_text', text: 'additional runtime context' }] }) + '\n');
      await processTranscriptOnce(first.input, childPath);
      expect(transcriptCheckpoint(first.stateStore, childPath).activeTurn).toMatchObject({
        emittedStepCount: 0, delegation: { invocationId: invocation },
      });
      await first.stateStore.save();
      let active = restart ? await createDormantInput(root) : first;
      if (format === 'canonical') {
        // Codex persists canonical input before its separately emitted legacy mirror.
        await fs.appendFile(childPath, record(at(13.15), 'event_msg', {
          type: 'user_message', message: 'initial delegated work',
        }) + '\n');
        await processTranscriptOnce(active.input, childPath);
        expect(transcriptCheckpoint(active.stateStore, childPath).activeTurn).toMatchObject({
          delegation: { invocationId: invocation },
        });
      }
      if (incoming !== 'none') {
        const payload = incoming === 'user'
          ? format === 'canonical'
            ? { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'initial delegated work' }] }
            : { type: 'user_message', message: 'initial delegated work' }
          : { type: 'agent_message', author: incoming === 'result' ? '/root/child/leaf' : '/root', recipient: '/root/child',
            content: [{ type: 'input_text', text: incoming === 'result' ? 'Message Type: FINAL_ANSWER\nleaf done' : 'Message Type: NEW_TASK\nnew unobserved work' }],
            internal_chat_message_metadata_passthrough: { turn_id: 'child-turn' } };
        await fs.appendFile(childPath, record(at(13.2), incoming === 'user' && format === 'legacy' ? 'event_msg' : 'response_item', payload) + '\n');
        await processTranscriptOnce(active.input, childPath);
      }
      await fs.appendFile(childPath, [
        record(at(14), 'response_item', { type: 'function_call', call_id: 'work-tool', name: 'exec_command', arguments: '{}' }),
        record(at(14.1), 'response_item', { type: 'function_call_output', call_id: 'work-tool', output: 'ok' }),
        record(at(14.2), 'event_msg', tokenUsage(20, 3)),
      ].join('\n') + '\n');
      await processTranscriptOnce(active.input, childPath);
      expect(transcriptCheckpoint(active.stateStore, childPath).activeTurn).toMatchObject({ emittedStepCount: 1 });
      const earlierResponses = responsesForTurn(active.entries, 'child-turn');
      if (restart) {
        await active.stateStore.save();
        active = await createDormantInput(root);
      }

      await fs.appendFile(childPath, [
        record(at(15), 'response_item', { type: 'function_call', call_id: 'second-tool', name: 'exec_command', arguments: '{}' }),
        record(at(15.1), 'response_item', { type: 'function_call_output', call_id: 'second-tool', output: 'ok' }),
        record(at(15.2), 'event_msg', tokenUsage(30, 4)),
      ].join('\n') + '\n');
      await processTranscriptOnce(active.input, childPath);
      const responses = restart ? [...earlierResponses, ...responsesForTurn(active.entries, 'child-turn')]
        : responsesForTurn(active.entries, 'child-turn');
      expect(responses).toHaveLength(2);
      for (const response of responses) expect(response['gen_ai.agent.parent.invocation.id']).toBe(
        incoming === 'user' || incoming === 'agent' ? undefined : invocation);
      const followup = first.entries.find(entry => entry['event.name'] === 'gen_ai.agent.invoke'
        && entry['gen_ai.tool.call.id'] === 'queued-followup')!['gen_ai.agent.invocation.id'];
      await fs.appendFile(childPath, [
        record(at(16), 'response_item', { type: 'agent_message', author: '/root', recipient: '/root/child',
          content: [{ type: 'input_text', text: 'replacement work' }],
          internal_chat_message_metadata_passthrough: { turn_id: 'child-turn' } }),
        record(at(17), 'event_msg', { type: 'agent_message', message: 'replacement done', phase: 'final' }),
        record(at(17.1), 'event_msg', tokenUsage(40, 5)),
        record(at(18), 'event_msg', { type: 'task_complete', turn_id: 'child-turn', last_agent_message: 'replacement done' }),
      ].join('\n') + '\n');
      await processTranscriptOnce(active.input, childPath);
      expect(responsesForTurn(active.entries, 'child-turn').at(-1)!['gen_ai.agent.parent.invocation.id']).toBe(followup);
      expect(transcriptCheckpoint(active.stateStore, childPath).activeTurn).toBeNull();
    },
  );

  it.each(['status', 'results'].flatMap(format => ['', 'actual result'].map(body => ({ format, body }))))(
    'does not deliver a null-only completion before the real result (format=$format, body=$body)',
    async ({ format, body }) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-null-result-'));
      tempDirs.push(root);
      const { input, entries, sessionDir, stateStore } = await createDormantInput(root);
      const session = 'null-result-parent';
      const child = 'null-result-child';
      const start = '2026-08-07T03:25:00.000Z';
      const at = (seconds: number) => new Date(Date.parse(start) + seconds * 1_000).toISOString();
      const lines = simpleCompletedTurn(session, 'parent-turn', 'delegate', 'accepted', 10, 2, start);
      const status = (value: string | null) => format === 'status'
        ? { status: { [child]: { completed: value } } }
        : { results: [{ agent_id: child, status: 'completed', output: value }] };
      lines.splice(4, 0,
        record(at(3.1), 'response_item', { type: 'function_call', call_id: 'null-spawn', name: 'spawn_agent',
          arguments: JSON.stringify({ task_name: 'child', message: 'work' }) }),
        record(at(3.2), 'response_item', { type: 'function_call_output', call_id: 'null-spawn', output: JSON.stringify({ agent_id: child }) }),
        record(at(3.3), 'response_item', { type: 'function_call', call_id: 'empty-wait', name: 'wait_agent', arguments: '{}' }),
        record(at(3.4), 'response_item', { type: 'function_call_output', call_id: 'empty-wait', output: JSON.stringify(status(null)) }));
      const transcript = await writeTranscriptNamed(sessionDir, 'rollout-null-result-parent.jsonl', lines.join('\n') + '\n');
      await processTranscriptOnce(input, transcript);
      expect(entries.filter(entry => entry['event.name'] === 'gen_ai.agent.result')).toHaveLength(0);
      const invocation = entries.find(entry => entry['event.name'] === 'gen_ai.agent.invoke')!['gen_ai.agent.invocation.id'];
      expect(stateStore.get('codex-transcript').extra?.codexResultInvocations ?? []).not.toContain(invocation);
      expect(transcriptCheckpoint(stateStore, transcript).activeTurn).toBeNull();
      const receipt = simpleCompletedTurn(session, 'receipt-turn', 'collect', 'received', 20, 3, at(10)).slice(1);
      receipt.splice(3, 0,
        record(at(13.1), 'response_item', { type: 'function_call', call_id: 'actual-wait', name: 'wait_agent', arguments: '{}' }),
        record(at(13.2), 'response_item', { type: 'function_call_output', call_id: 'actual-wait', output: JSON.stringify(status(body)) }),
        record(at(13.3), 'response_item', { type: 'agent_message', author: child, recipient: '/root',
          content: [{ type: 'input_text', text: `Message Type: FINAL_ANSWER\n${body}` }],
          internal_chat_message_metadata_passthrough: { turn_id: 'receipt-turn', tool_call_id: 'null-spawn' } }));
      await fs.appendFile(transcript, receipt.join('\n') + '\n');
      await processTranscriptOnce(input, transcript);
      const results = entries.filter(entry => entry['event.name'] === 'gen_ai.agent.result');
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ 'gen_ai.agent.invocation.id': invocation,
        'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content: body }] }] });
      expect(transcriptCheckpoint(stateStore, transcript).activeTurn).toBeNull();
      await processTranscriptOnce(input, transcript);
      expect(entries.filter(entry => entry['event.name'] === 'gen_ai.agent.result')).toHaveLength(1);
    },
  );

  it('binds agent_id-only spawn, reused child work and nested invocation to their immediate callers', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-subagent-reuse-nested-'));
    tempDirs.push(root);
    const { input, entries, sessionDir } = await createDormantInput(root);
    const parentId = 'parent-reuse';
    const childId = 'child-reuse';
    const grandchildId = 'grandchild-reuse';
    const dispatchedTurn = (
      session: string, turn: string, prompt: string, start: string,
      callId: string, name: string, target: string, work: string,
    ): string[] => {
      const lines = simpleCompletedTurn(session, turn, prompt, 'delegated', 100, 10, start);
      const base = Date.parse(start);
      if (session !== parentId) lines[3] = record(new Date(base + 3_000).toISOString(), 'response_item', {
        type: 'agent_message', author: '/root', recipient: '/root/reused',
        content: [{ type: 'input_text', text: prompt }],
        internal_chat_message_metadata_passthrough: { turn_id: turn },
      });
      lines.splice(4, 0,
        record(new Date(base + 3_100).toISOString(), 'response_item', {
          type: 'function_call', call_id: callId, name,
          arguments: JSON.stringify({ id: target, message: work }),
        }),
        record(new Date(base + 3_200).toISOString(), 'response_item', {
          type: 'function_call_output', call_id: callId,
          output: JSON.stringify({ agent_id: target, nickname: target === grandchildId ? 'Euler' : 'Newton' }),
        }),
      );
      return lines;
    };
    const childMeta = (id: string, parent: string, depth: number, timestamp: string): string =>
      record(timestamp, 'session_meta', {
        id, session_id: parentId, timestamp, thread_source: 'subagent', model_provider: 'openai',
        source: { subagent: { thread_spawn: { parent_thread_id: parent, depth, agent_nickname: id === childId ? 'Newton' : 'Euler' } } },
      });

    const parentTranscript = await writeTranscriptNamed(sessionDir, 'rollout-parent-reuse.jsonl', dispatchedTurn(
      parentId, 'parent-first', 'delegate first', '2026-08-07T03:00:00.000Z',
      'spawn-first', 'spawn_agent', childId, 'first child work',
    ).join('\n') + '\n');
    await processTranscriptOnce(input, parentTranscript);
    const firstChild = simpleCompletedTurn(childId, 'child-first', 'first child work', 'first done',
      80, 8, '2026-08-07T03:00:10.000Z');
    firstChild[0] = childMeta(childId, parentId, 1, '2026-08-07T03:00:09.000Z');
    const childTranscript = await writeTranscriptNamed(sessionDir, 'rollout-child-reuse.jsonl', firstChild.join('\n') + '\n');
    await processTranscriptOnce(input, childTranscript);
    const firstInvoke = entries.find(entry => entry['event.name'] === 'gen_ai.agent.invoke'
      && entry['gen_ai.tool.call.id'] === 'spawn-first')!;
    expect(firstInvoke).toMatchObject({ 'gen_ai.agent.peer.id': childId });
    expect(responsesForTurn(entries, 'child-first')[0]).toMatchObject({
      'gen_ai.session.id': childId,
      'gen_ai.agent.parent.invocation.id': firstInvoke['gen_ai.agent.invocation.id'],
      'agent.codex.parent_span_id': firstInvoke.span_id,
    });
    // An accepted dispatch is not a delivered child result.
    expect(entries.filter(entry => entry['event.name'] === 'gen_ai.agent.result')).toHaveLength(0);

    await fs.appendFile(parentTranscript, dispatchedTurn(
      parentId, 'parent-second', 'delegate second', '2026-08-07T03:01:00.000Z',
      'followup-second', 'followup_task', childId, 'second child work',
    ).slice(1).join('\n') + '\n', 'utf8');
    await processTranscriptOnce(input, parentTranscript);
    await fs.appendFile(childTranscript, dispatchedTurn(
      childId, 'child-second', 'second child work', '2026-08-07T03:01:10.000Z',
      'nested-spawn', 'spawn_agent', grandchildId, 'nested work',
    ).slice(1).join('\n') + '\n', 'utf8');
    await processTranscriptOnce(input, childTranscript);
    const secondInvoke = entries.find(entry => entry['event.name'] === 'gen_ai.agent.invoke'
      && entry['gen_ai.tool.call.id'] === 'followup-second')!;
    const nestedInvoke = entries.find(entry => entry['event.name'] === 'gen_ai.agent.invoke'
      && entry['gen_ai.tool.call.id'] === 'nested-spawn')!;
    expect(secondInvoke['gen_ai.agent.invocation.id']).not.toBe(firstInvoke['gen_ai.agent.invocation.id']);
    expect(firstInvoke['gen_ai.agent.peer.name']).toBe('Newton');
    expect(secondInvoke['gen_ai.agent.peer.name']).toBe('Newton');
    expect(nestedInvoke['gen_ai.agent.peer.name']).toBe('Euler');
    expect(nestedInvoke['gen_ai.agent.name']).toBe('Newton');
    expect(responsesForTurn(entries, 'child-second')[0]).toMatchObject({
      'gen_ai.session.id': childId,
      'gen_ai.turn.id': `${childId}:child-second`,
      'gen_ai.agent.parent.invocation.id': secondInvoke['gen_ai.agent.invocation.id'],
      'agent.codex.parent_span_id': secondInvoke.span_id,
      trace_id: secondInvoke.trace_id,
    });
    expect(nestedInvoke).toMatchObject({
      'gen_ai.session.id': childId,
      'gen_ai.agent.parent.invocation.id': secondInvoke['gen_ai.agent.invocation.id'],
      'gen_ai.agent.invocation.id': expect.any(String),
    });
    const nested = simpleCompletedTurn(grandchildId, 'grandchild-first', 'nested work', 'nested done',
      30, 3, '2026-08-07T03:01:20.000Z');
    nested[0] = childMeta(grandchildId, childId, 2, '2026-08-07T03:01:19.000Z');
    const grandchildTranscript = await writeTranscriptNamed(sessionDir, 'rollout-grandchild-reuse.jsonl', nested.join('\n') + '\n');
    await processTranscriptOnce(input, grandchildTranscript);
    expect(responsesForTurn(entries, 'grandchild-first')[0]).toMatchObject({
      'gen_ai.session.id': grandchildId,
      'gen_ai.agent.parent.id': childId,
      'gen_ai.agent.parent.invocation.id': nestedInvoke['gen_ai.agent.invocation.id'],
      'agent.codex.parent_span_id': nestedInvoke.span_id,
      'gen_ai.agent.depth': 2,
    });
    const invocations = entries.filter(entry => entry['event.name'] === 'gen_ai.agent.invoke');
    expect(invocations).toHaveLength(3);
    expect(new Set(invocations.map(entry => entry['gen_ai.agent.invocation.id'])).size).toBe(3);
    const receivingTurn = simpleCompletedTurn(parentId, 'parent-receives-result', 'collect result', 'received',
      20, 2, '2026-08-07T03:02:00.000Z').slice(1);
    receivingTurn.splice(3, 0, record('2026-08-07T03:02:03.500Z', 'event_msg', {
      type: 'sub_agent_activity', kind: 'completed', event_id: 'followup-second',
      agent_thread_id: childId, output: 'actual second child result',
    }));
    await fs.appendFile(parentTranscript, receivingTurn.join('\n') + '\n', 'utf8');
    await processTranscriptOnce(input, parentTranscript);
    const results = entries.filter(entry => entry['event.name'] === 'gen_ai.agent.result');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      'gen_ai.session.id': parentId,
      'gen_ai.turn.id': `${parentId}:parent-receives-result`,
      'gen_ai.agent.invocation.id': secondInvoke['gen_ai.agent.invocation.id'],
      'gen_ai.agent.peer.id': childId,
    });
    expect(results[0]).not.toHaveProperty('span_id');
    await fs.appendFile(childTranscript, simpleCompletedTurn(childId, 'direct-user-turn', 'first child work', 'direct response',
      10, 1, '2026-08-07T03:03:00.000Z').slice(1).join('\n') + '\n', 'utf8');
    await processTranscriptOnce(input, childTranscript);
    const direct = responsesForTurn(entries, 'direct-user-turn')[0]!;
    expect(direct['gen_ai.session.id']).toBe(childId);
    expect(direct['gen_ai.agent.parent.invocation.id']).toBeUndefined();
    expect(direct['agent.codex.parent_span_id']).toBeUndefined();
    expect(direct.trace_id).not.toBe(firstInvoke.trace_id);
    const count = entries.length;
    await processTranscriptOnce(input, childTranscript);
    await processTranscriptOnce(input, parentTranscript);
    await processTranscriptOnce(input, grandchildTranscript);
    expect(entries).toHaveLength(count);
  });

  it.each([false, true])('keeps a coordinator incoming invocation after a streamed nested FINAL_ANSWER (restart=%s)', async restart => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-streamed-nested-result-'));
    tempDirs.push(root);
    const first = await createDormantInput(root);
    const parent = 'streamed-parent';
    const child = 'streamed-coordinator';
    const base = Date.parse('2026-08-07T03:30:00.000Z');
    const at = (seconds: number) => new Date(base + seconds * 1_000).toISOString();
    const parentLines = simpleCompletedTurn(parent, 'parent-turn', 'delegate', 'accepted', 10, 2, at(0));
    parentLines.splice(4, 0,
      record(at(3.1), 'response_item', { type: 'function_call', call_id: 'coordinator-spawn', name: 'spawn_agent',
        arguments: JSON.stringify({ task_name: 'coordinator', message: 'opaque-coordinator-work' }) }),
      record(at(3.2), 'response_item', { type: 'function_call_output', call_id: 'coordinator-spawn', output: JSON.stringify({ agent_id: child }) }));
    const parentPath = await writeTranscriptNamed(first.sessionDir, 'rollout-streamed-parent.jsonl', parentLines.join('\n') + '\n');
    await processTranscriptOnce(first.input, parentPath);
    const invocation = first.entries.find(entry => entry['event.name'] === 'gen_ai.agent.invoke')!;
    const childPath = await writeTranscriptNamed(first.sessionDir, 'rollout-streamed-coordinator.jsonl', [
      record(at(6), 'session_meta', { id: child, session_id: parent, thread_source: 'subagent', model_provider: 'openai',
        source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_path: '/root/coordinator' } } } }),
      record(at(7), 'event_msg', { type: 'task_started', turn_id: 'coordinator-turn' }),
      record(at(7.1), 'turn_context', { turn_id: 'coordinator-turn', model: 'gpt-test' }),
      record(at(7.2), 'response_item', { type: 'agent_message', author: '/root', recipient: '/root/coordinator',
        content: [{ type: 'input_text', text: 'Message Type: NEW_TASK' }, { type: 'encrypted_content', encrypted_content: 'opaque-coordinator-work' }],
        internal_chat_message_metadata_passthrough: { turn_id: 'coordinator-turn' } }),
      record(at(8), 'response_item', { type: 'function_call', call_id: 'leaf-spawn', name: 'spawn_agent',
        arguments: JSON.stringify({ task_name: 'leaf', message: 'opaque-leaf-work' }) }),
      record(at(9), 'response_item', { type: 'function_call_output', call_id: 'leaf-spawn', output: JSON.stringify({ agent_id: 'streamed-leaf' }) }),
      record(at(9.1), 'event_msg', tokenUsage(20, 3)),
    ].join('\n') + '\n', { bootstrapFork: false });
    await writeWakeupMarker(first.wakeupDir, child, { session_id: child, initial_turn_id: 'coordinator-turn', turn_id: 'coordinator-turn',
      transcript_path: childPath, hook_event: 'subagent-stop', received_at: new Date().toISOString() });
    await processTranscriptOnce(first.input, childPath);
    expect(responsesForTurn(first.entries, 'coordinator-turn')).toHaveLength(1);
    expect(transcriptCheckpoint(first.stateStore, childPath).activeTurn).toMatchObject({ emittedStepCount: 1 });
    await first.stateStore.save();
    const active = restart ? await createDormantInput(root) : first;
    await fs.appendFile(childPath, [
      record(at(10), 'response_item', { type: 'agent_message', author: '/root/coordinator/leaf', recipient: '/root/coordinator',
        content: [{ type: 'input_text', text: 'Message Type: FINAL_ANSWER\nTask name: /root/coordinator/leaf\nPayload:\nleaf done' },
          { type: 'encrypted_content', encrypted_content: 'opaque-leaf-result' }],
        internal_chat_message_metadata_passthrough: { turn_id: 'coordinator-turn' } }),
      record(at(11), 'event_msg', { type: 'agent_message', message: 'coordinator done', phase: 'final' }),
      record(at(11.1), 'event_msg', tokenUsage(30, 4)),
      record(at(12), 'event_msg', { type: 'task_complete', turn_id: 'coordinator-turn', last_agent_message: 'coordinator done' }),
    ].join('\n') + '\n');
    await processTranscriptOnce(active.input, childPath);
    const all = restart ? [...first.entries, ...active.entries] : active.entries;
    const childEntries = all.filter(entry => entry['gen_ai.session.id'] === child);
    expect(responsesForTurn(all, 'coordinator-turn')).toHaveLength(2);
    for (const entry of childEntries) expect(entry).toMatchObject({
      'gen_ai.agent.parent.invocation.id': invocation['gen_ai.agent.invocation.id'],
      'agent.codex.parent_span_id': invocation.span_id, trace_id: invocation.trace_id,
    });
    const nestedInvoke = childEntries.find(entry => entry['event.name'] === 'gen_ai.agent.invoke')!;
    expect(nestedInvoke['gen_ai.agent.invocation.id']).not.toBe(invocation['gen_ai.agent.invocation.id']);
    expect(childEntries.find(entry => entry['gen_ai.turn.end'] === true)).toBeDefined();
    const starts = childEntries.filter(entry => entry['gen_ai.turn.start'] === true);
    expect(starts).toHaveLength(1);
    expect(starts[0]!['event.name']).toBe('other');
    expect(entryTimestampMs(starts[0]!)).toBe(base + 7_000);
    expect(childEntries.filter(entry => entry['event.name'] !== 'other')
      .every(entry => entry['gen_ai.turn.start'] === undefined)).toBe(true);
    const count = active.entries.length;
    await processTranscriptOnce(active.input, childPath);
    expect(active.entries).toHaveLength(count);
  });

  it.each([false, true])('resolves a parent-first pending result after interrupted child reuse arrives (restart=%s)', async restart => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-late-reused-result-'));
    tempDirs.push(root);
    const first = await createDormantInput(root);
    const parent = 'late-result-parent';
    const child = 'late-result-child';
    const base = Date.parse('2026-08-07T04:00:00.000Z');
    const at = (seconds: number) => new Date(base + seconds * 1_000).toISOString();
    const actualResult = 'actual completed second work';
    const parentRecords = [
      record(at(0), 'session_meta', { id: parent, thread_source: 'user', model_provider: 'openai' }),
      record(at(1), 'turn_context', { turn_id: 'parent-work', model: 'gpt-test' }),
      record(at(2), 'event_msg', { type: 'task_started', turn_id: 'parent-work' }),
      record(at(3), 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'delegate twice' }] }),
      record(at(4), 'response_item', { type: 'function_call', call_id: 'first-spawn', name: 'spawn_agent',
        arguments: JSON.stringify({ task_name: 'late-child', message: 'opaque-first' }) }),
      record(at(5), 'response_item', { type: 'function_call_output', call_id: 'first-spawn', output: JSON.stringify({ agent_id: child }) }),
      record(at(10), 'response_item', { type: 'function_call', call_id: 'second-work', name: 'followup_task',
        arguments: JSON.stringify({ target: '/root/late-child', message: 'opaque-second' }) }),
      record(at(11), 'response_item', { type: 'function_call_output', call_id: 'second-work', output: JSON.stringify({ agent_id: child }) }),
      record(at(18), 'response_item', { type: 'agent_message', author: '/root/late-child', recipient: '/root',
        content: [{ type: 'input_text', text: `Message Type: FINAL_ANSWER\nTask name: /root/late-child\nSender: /root/late-child\nPayload:\n${actualResult}` }],
        internal_chat_message_metadata_passthrough: { turn_id: 'parent-work' } }),
      record(at(19), 'event_msg', tokenUsage(10, 2)),
      record(at(20), 'event_msg', { type: 'task_complete', turn_id: 'parent-work', last_agent_message: 'received' }),
    ];
    const parentPath = await writeTranscriptNamed(first.sessionDir, 'rollout-late-result-parent.jsonl', parentRecords.join('\n') + '\n');
    await processTranscriptOnce(first.input, parentPath);
    expect(first.entries.filter(entry => entry['event.name'] === 'gen_ai.agent.invoke')).toHaveLength(2);
    expect(first.entries.filter(entry => entry['event.name'] === 'gen_ai.agent.result')).toHaveLength(0);
    expect((first.stateStore.get('codex-transcript').extra?.codexPendingAgentResults as unknown[])).toHaveLength(1);
    expect(JSON.stringify(first.stateStore.get('codex-transcript').extra?.codexPendingAgentResults)).not.toContain(actualResult);
    await first.stateStore.save();
    const active = restart ? await createDormantInput(root) : first;
    const incoming = (turn: string, message: string, seconds: number) => record(at(seconds), 'response_item', {
      type: 'agent_message', author: '/root', recipient: '/root/late-child',
      content: [{ type: 'input_text', text: 'Message Type: NEW_TASK' }, { type: 'encrypted_content', encrypted_content: message }],
      internal_chat_message_metadata_passthrough: { turn_id: turn },
    });
    const childRecords = [
      record(at(4.5), 'session_meta', { id: child, session_id: parent, thread_source: 'subagent', model_provider: 'openai',
        source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_path: '/root/late-child' } } } }),
      record(at(5.5), 'turn_context', { turn_id: 'child-first', model: 'gpt-test' }),
      record(at(5.6), 'event_msg', { type: 'task_started', turn_id: 'child-first' }),
      incoming('child-first', 'opaque-first', 5.7),
      record(at(6), 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'partial first' }] }),
      record(at(8), 'event_msg', { type: 'turn_aborted', turn_id: 'child-first', reason: 'interrupted' }),
      record(at(11.5), 'turn_context', { turn_id: 'child-second', model: 'gpt-test' }),
      record(at(11.6), 'event_msg', { type: 'task_started', turn_id: 'child-second' }),
      incoming('child-second', 'opaque-second', 11.7),
      record(at(15), 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: actualResult }] }),
      record(at(16), 'event_msg', tokenUsage(20, 3)),
      record(at(17), 'event_msg', { type: 'task_complete', turn_id: 'child-second', last_agent_message: actualResult }),
    ];
    const childPath = await writeTranscriptNamed(active.sessionDir, 'rollout-late-result-child.jsonl', childRecords.join('\n') + '\n', { bootstrapFork: false });
    await writeWakeupMarker(active.wakeupDir, child, { session_id: child, initial_turn_id: 'child-first', turn_id: 'child-second',
      transcript_path: childPath, hook_event: 'subagent-stop', received_at: new Date().toISOString() });
    await runInputCycle(active.input);
    const allEntries = restart ? [...first.entries, ...active.entries] : active.entries;
    const invokes = allEntries.filter(entry => entry['event.name'] === 'gen_ai.agent.invoke');
    const result = allEntries.filter(entry => entry['event.name'] === 'gen_ai.agent.result');
    expect(result).toHaveLength(1);
    const second = invokes.find(entry => entry['gen_ai.tool.call.id'] === 'second-work')!;
    expect(result[0]).toMatchObject({ 'gen_ai.session.id': parent, 'gen_ai.turn.id': `${parent}:parent-work`,
      'gen_ai.agent.invocation.id': second['gen_ai.agent.invocation.id'], 'gen_ai.agent.peer.id': child });
    expect(entryTimestampMs(result[0]!)).toBe(base + 18_000);
    expect(result[0]).not.toHaveProperty('span_id');
    expect((active.stateStore.get('codex-transcript').extra?.codexPendingAgentResults as unknown[])).toHaveLength(0);
    expect(responsesForTurn(allEntries, 'child-first')[0]!['gen_ai.agent.parent.invocation.id'])
      .toBe(invokes.find(entry => entry['gen_ai.tool.call.id'] === 'first-spawn')!['gen_ai.agent.invocation.id']);
    const before = active.entries.length;
    await runInputCycle(active.input);
    expect(active.entries).toHaveLength(before);
  });

  it('retains a same-text receipt across restart while another candidate has no terminal evidence', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-identical-result-'));
    tempDirs.push(root);
    const first = await createDormantInput(root);
    const parent = 'same-result-parent';
    const child = 'same-result-child';
    const base = Date.parse('2026-08-07T05:00:00.000Z');
    const firstWork = { parentThreadId: parent, parentTurnId: 'first-parent', parentTraceId: 'a'.repeat(32),
      parentToolCallId: 'first-call', childThreadId: child, agentPath: '/root/same-child', invocationId: 'I1', spawnedAtMs: base - 1 };
    const secondWork = { ...firstWork, parentTurnId: 'second-parent', parentToolCallId: 'second-call', invocationId: 'I2', spawnedAtMs: base + 60_000 };
    const linker = (input: CodexTranscriptInput) => (input as unknown as { subagentLinker: {
      registerSpawns(values: unknown[]): void;
      registerCompletedWorkResult(link: unknown, turn: unknown, records: unknown[]): void;
    } }).subagentLinker;
    const terminal = (input: CodexTranscriptInput, work: typeof firstWork, turn: string, withBody = true) => linker(input).registerCompletedWorkResult(
      { ...work, confidence: 'explicit_id' }, { sessionId: child, transcriptTurnId: turn, status: 'completed' },
      [{ startOffset: 0, endOffset: 1, record: { type: 'event_msg', payload: {
        type: 'task_complete', turn_id: turn, ...(withBody ? { last_agent_message: 'done' } : {}),
      } } }],
    );
    const receiptTurn = (turn: string, seconds: number, explicitInvocation?: string) => {
      const start = new Date(base + seconds * 1_000).toISOString();
      const records = simpleCompletedTurn(parent, turn, 'receive result', 'received', 10, 1, start);
      records.splice(4, 0, record(new Date(base + seconds * 1_000 + 3_500).toISOString(), 'response_item', {
        type: 'agent_message', author: '/root/same-child', recipient: '/root',
        content: [{ type: 'input_text', text: 'Message Type: FINAL_ANSWER\nPayload:\ndone' }],
        internal_chat_message_metadata_passthrough: { turn_id: turn, ...(explicitInvocation ? { invocation_id: explicitInvocation } : {}) },
      }));
      return records;
    };
    linker(first.input).registerSpawns([firstWork]);
    terminal(first.input, firstWork, 'child-one');
    const parentPath = await writeTranscriptNamed(first.sessionDir, 'rollout-same-result-parent.jsonl', receiptTurn('first-parent', 0).join('\n') + '\n');
    await processTranscriptOnce(first.input, parentPath);
    expect(first.entries.filter(entry => entry['event.name'] === 'gen_ai.agent.result').map(entry => entry['gen_ai.agent.invocation.id'])).toEqual(['I1']);
    linker(first.input).registerSpawns([secondWork]);
    await fs.appendFile(parentPath, receiptTurn('second-parent', 70).slice(1).join('\n') + '\n', 'utf8');
    await processTranscriptOnce(first.input, parentPath);
    expect(first.entries.filter(entry => entry['event.name'] === 'gen_ai.agent.result')).toHaveLength(1);
    expect((first.stateStore.get('codex-transcript').extra?.codexPendingAgentResults as unknown[])).toHaveLength(1);
    // A source-explicit duplicate remains safe to deduplicate even while I2 is unknown.
    await fs.appendFile(parentPath, receiptTurn('explicit-old-duplicate', 80, 'I1').slice(1).join('\n') + '\n', 'utf8');
    await processTranscriptOnce(first.input, parentPath);
    expect(first.entries.filter(entry => entry['event.name'] === 'gen_ai.agent.result')).toHaveLength(1);
    await first.stateStore.save();
    const recovered = await createDormantInput(root);
    await runInputCycle(recovered.input);
    expect(recovered.entries.filter(entry => entry['event.name'] === 'gen_ai.agent.result')).toHaveLength(0);
    expect((recovered.stateStore.get('codex-transcript').extra?.codexPendingAgentResults as unknown[])).toHaveLength(1);
    terminal(recovered.input, secondWork, 'child-two', false);
    await runInputCycle(recovered.input);
    // A completed terminal without a body still cannot exclude same-text I2.
    expect(recovered.entries.filter(entry => entry['event.name'] === 'gen_ai.agent.result')).toHaveLength(0);
    expect((recovered.stateStore.get('codex-transcript').extra?.codexPendingAgentResults as unknown[])).toHaveLength(1);
    terminal(recovered.input, secondWork, 'child-two');
    await runInputCycle(recovered.input);
    // Both real completions say done, so author/path alone still cannot choose I2.
    expect(recovered.entries.filter(entry => entry['event.name'] === 'gen_ai.agent.result')).toHaveLength(0);
    expect((recovered.stateStore.get('codex-transcript').extra?.codexPendingAgentResults as unknown[])).toHaveLength(1);
    await fs.appendFile(parentPath, receiptTurn('explicit-new-result', 90, 'I2').slice(1).join('\n') + '\n', 'utf8');
    await runInputCycle(recovered.input);
    expect(recovered.entries.filter(entry => entry['event.name'] === 'gen_ai.agent.result').map(entry => entry['gen_ai.agent.invocation.id'])).toEqual(['I2']);
    expect((recovered.stateStore.get('codex-transcript').extra?.codexPendingAgentResults as unknown[])).toHaveLength(0);
    const before = recovered.entries.length;
    await runInputCycle(recovered.input);
    expect(recovered.entries).toHaveLength(before);
  });

  it('degrades an ambiguous repeated agent path to an independent child trace', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-subagent-ambiguous-path-'));
    tempDirs.push(root);
    const { input, entries, sessionDir, stateStore } = await createDormantInput(root);
    const parentFixture = (await fs.readFile(
      path.join(SUBAGENT_FIXTURE_DIR, PARENT_FIXTURE_NAME),
      'utf8',
    )).trimEnd().split('\n')
      .filter(line => !line.includes('call-subagent-3') && !line.includes('call-subagent-4'))
      .map(line => line.replaceAll('fixture_child_2', 'fixture_child'))
      .join('\n') + '\n';
    const parentTranscript = await writeTranscriptNamed(sessionDir, PARENT_FIXTURE_NAME, parentFixture);
    const childFixture = await fs.readFile(path.join(SUBAGENT_FIXTURE_DIR, CHILD_FIXTURE_NAME), 'utf8');
    const childTranscript = await writeTranscriptNamed(sessionDir, CHILD_FIXTURE_NAME, childFixture);

    await processTranscriptOnce(input, parentTranscript);
    await processTranscriptOnce(input, childTranscript);

    expect(responsesForTurn(entries, 'child-turn-1')).toHaveLength(1);
    expect(transcriptCheckpoint(stateStore, childTranscript)).toMatchObject({
      pendingSubagent: null,
      activeTurn: null,
    });
    expect(input.getSubagentLinkSnapshot().links).toContainEqual(expect.objectContaining({
      childThreadId: CHILD_FIXTURES[0].threadId,
      confidence: 'orphan',
      orphanReason: 'ambiguous_agent_path',
    }));
  });

  it('does not replay a completed child if a later spawn makes its path ambiguous', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-subagent-late-ambiguity-'));
    tempDirs.push(root);
    const { input, entries, sessionDir, stateStore } = await createDormantInput(root);
    const parentFixture = await fs.readFile(path.join(SUBAGENT_FIXTURE_DIR, PARENT_FIXTURE_NAME), 'utf8');
    const parentLines = parentFixture.trimEnd().split('\n')
      .filter(line => (
        !line.includes('call-subagent-2')
        && !line.includes('call-subagent-3')
        && !line.includes('call-subagent-4')
        && !line.includes('"type":"task_complete"')
      ));
    const parentTranscript = await writeTranscriptNamed(
      sessionDir,
      PARENT_FIXTURE_NAME,
      parentLines.join('\n') + '\n',
    );
    await processTranscriptOnce(input, parentTranscript);

    const childFixture = await fs.readFile(path.join(SUBAGENT_FIXTURE_DIR, CHILD_FIXTURE_NAME), 'utf8');
    const childTranscript = await writeTranscriptNamed(sessionDir, CHILD_FIXTURE_NAME, childFixture);
    await processTranscriptOnce(input, childTranscript);
    expect(transcriptCheckpoint(stateStore, childTranscript)).toMatchObject({
      pendingSubagent: null,
      activeTurn: null,
    });

    await fs.appendFile(parentTranscript, [
      record('2026-08-07T02:00:07.000Z', 'response_item', {
        type: 'function_call',
        call_id: 'call-subagent-late',
        name: 'spawn_agent',
        arguments: JSON.stringify({ task_name: 'fixture_child', message: 'redacted' }),
      }),
      record('2026-08-07T02:00:08.000Z', 'response_item', {
        type: 'function_call_output',
        call_id: 'call-subagent-late',
        output: JSON.stringify({ task_name: '/root/fixture_child' }),
      }),
      record('2026-08-07T02:00:09.000Z', 'event_msg', tokenUsage(120, 12)),
    ].join('\n') + '\n', 'utf8');
    await processTranscriptOnce(input, parentTranscript);
    await processTranscriptOnce(input, childTranscript);

    expect(input.getSubagentLinkSnapshot().links).toContainEqual(expect.objectContaining({
      childThreadId: CHILD_FIXTURES[0].threadId,
      confidence: 'orphan',
      orphanReason: 'ambiguous_agent_path',
    }));
    expect(responsesForTurn(entries, 'child-turn-1')).toHaveLength(1);
    expect(transcriptCheckpoint(stateStore, childTranscript)).toMatchObject({ pendingSubagent: null });
  });

  it('uses explicit child ids and parentToolCallId to keep repeated paths as distinct candidates', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-subagent-explicit-identity-'));
    tempDirs.push(root);
    const { input, entries, sessionDir, stateStore } = await createDormantInput(root);
    const originalParent = await fs.readFile(path.join(SUBAGENT_FIXTURE_DIR, PARENT_FIXTURE_NAME), 'utf8');
    const parentLines = originalParent.trimEnd().split('\n');
    const parentTerminal = parentLines.pop()!;
    const reducedParent = parentLines
      .filter(line => !line.includes('call-subagent-3') && !line.includes('call-subagent-4'))
      .map(line => line.replaceAll('fixture_child_2', 'fixture_child'));
    reducedParent.splice(reducedParent.length - 1, 0,
      record('2026-08-07T02:00:04.400Z', 'event_msg', {
        type: 'sub_agent_activity',
        kind: 'started',
        event_id: 'call-subagent-1',
        agent_thread_id: CHILD_FIXTURES[0].threadId,
        agent_path: '/root/fixture_child',
        occurred_at_ms: Date.parse('2026-08-07T02:00:04.400Z'),
      }),
      record('2026-08-07T02:00:04.450Z', 'event_msg', {
        type: 'sub_agent_activity',
        kind: 'started',
        event_id: 'call-subagent-2',
        agent_thread_id: CHILD_FIXTURES[1].threadId,
        agent_path: '/root/fixture_child',
        occurred_at_ms: Date.parse('2026-08-07T02:00:04.450Z'),
      }),
    );
    const parentTranscript = await writeTranscriptNamed(
      sessionDir,
      PARENT_FIXTURE_NAME,
      reducedParent.join('\n') + '\n',
    );
    await processTranscriptOnce(input, parentTranscript);

    const childTranscripts: string[] = [];
    for (const [index, fixture] of CHILD_FIXTURES.slice(0, 2).entries()) {
      let childText = await fs.readFile(path.join(SUBAGENT_FIXTURE_DIR, fixture.name), 'utf8');
      if (index === 1) childText = childText.replaceAll('/root/fixture_child_2', '/root/fixture_child');
      const transcript = await writeTranscriptNamed(sessionDir, fixture.name, childText);
      childTranscripts.push(transcript);
      await processTranscriptOnce(input, transcript);
    }

    expect(transcriptCheckpoint(stateStore, childTranscripts[0]!)).toMatchObject({
      pendingSubagent: null,
      activeTurn: null,
    });
    expect(transcriptCheckpoint(stateStore, childTranscripts[1]!)).toMatchObject({
      pendingSubagent: null,
      activeTurn: null,
    });

    await fs.appendFile(parentTranscript, parentTerminal + '\n', 'utf8');
    await processTranscriptOnce(input, parentTranscript);
    expect(transcriptCheckpoint(stateStore, parentTranscript).pendingFusion).toBeNull();
    await runInputCycle(input);

    expect(responsesForTurn(entries, CHILD_FIXTURES[0].turnId)).toHaveLength(1);
    expect(responsesForTurn(entries, CHILD_FIXTURES[1].turnId)).toHaveLength(1);
    expect(new Set(entries
      .filter(entry => entry['gen_ai.agent.scope'] === 'subagent')
      .map(entry => entry['gen_ai.subagent.parent_tool_call.id'])))
      .toEqual(new Set(['call-subagent-1', 'call-subagent-2']));
  });

  it('keeps time_order links diagnostic-only and emits the child independently', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-subagent-time-order-'));
    tempDirs.push(root);
    const { input, entries, sessionDir, stateStore } = await createDormantInput(root);
    const parentFixture = await fs.readFile(path.join(SUBAGENT_FIXTURE_DIR, PARENT_FIXTURE_NAME), 'utf8');
    const parentLines = parentFixture.trimEnd().split('\n');
    parentLines.pop();
    const parentTranscript = await writeTranscriptNamed(
      sessionDir,
      PARENT_FIXTURE_NAME,
      parentLines.join('\n') + '\n',
    );
    await processTranscriptOnce(input, parentTranscript);
    const childFixture = await fs.readFile(path.join(SUBAGENT_FIXTURE_DIR, CHILD_FIXTURE_NAME), 'utf8');
    const childLines = childFixture.trimEnd().split('\n').map((line, index) => {
      if (index !== 0) return line;
      const meta = JSON.parse(line) as { payload: Record<string, unknown> };
      const source = meta.payload.source as { subagent: { thread_spawn: Record<string, unknown> } };
      delete source.subagent.thread_spawn.agent_path;
      return JSON.stringify(meta);
    });
    const childTranscript = await writeTranscriptNamed(
      sessionDir,
      CHILD_FIXTURE_NAME,
      childLines.join('\n') + '\n',
    );
    await processTranscriptOnce(input, childTranscript);

    expect(input.getSubagentLinkSnapshot().links).toContainEqual(expect.objectContaining({
      childThreadId: CHILD_FIXTURES[0].threadId,
      confidence: 'time_order',
    }));
    expect(responsesForTurn(entries, 'child-turn-1')).toHaveLength(1);
    expect(transcriptCheckpoint(stateStore, childTranscript)).toMatchObject({ pendingSubagent: null });
  });

  it('restores a running child and its delegation after the parent finishes across restart', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-subagent-restart-'));
    tempDirs.push(root);
    const first = await createDormantInput(root);
    const parentFixture = await fs.readFile(path.join(SUBAGENT_FIXTURE_DIR, PARENT_FIXTURE_NAME), 'utf8');
    const parentTranscript = await writeTranscriptNamed(first.sessionDir, PARENT_FIXTURE_NAME, parentFixture);
    await processTranscriptOnce(first.input, parentTranscript);
    const childFixture = await fs.readFile(path.join(SUBAGENT_FIXTURE_DIR, CHILD_FIXTURE_NAME), 'utf8');
    const childLines = childFixture.trimEnd().split('\n');
    const childTerminal = childLines.pop()!;
    const childTranscript = await writeTranscriptNamed(first.sessionDir, CHILD_FIXTURE_NAME, childLines.join('\n') + '\n');
    await processTranscriptOnce(first.input, childTranscript);
    const invoke = first.entries.find(entry => entry['event.name'] === 'gen_ai.agent.invoke'
      && entry['gen_ai.tool.call.id'] === 'call-subagent-1')!;
    expect(invoke).toBeDefined();
    expect(responsesForTurn(first.entries, 'child-turn-1')).toHaveLength(0);
    await first.stateStore.save();

    const restarted = await createInput(root);
    try {
      await processTranscriptOnce(restarted.input, childTranscript);
      expect(responsesForTurn(restarted.entries, 'child-turn-1')).toHaveLength(0);
      await fs.appendFile(childTranscript, childTerminal + '\n', 'utf8');
      await waitFor(() => responsesForTurn(restarted.entries, 'child-turn-1').length === 1);
    } finally { await restarted.input.stop(); }

    expect(responsesForTurn(restarted.entries, 'parent-turn-1')).toHaveLength(0);
    expect(responsesForTurn(restarted.entries, 'child-turn-1')[0]).toMatchObject({
      'gen_ai.session.id': CHILD_FIXTURES[0].threadId,
      'gen_ai.turn.id': `${CHILD_FIXTURES[0].threadId}:child-turn-1`,
      'gen_ai.agent.parent.invocation.id': invoke['gen_ai.agent.invocation.id'],
      'agent.codex.parent_span_id': invoke.span_id,
      trace_id: invoke.trace_id,
    });
    expect(transcriptCheckpoint(restarted.stateStore, childTranscript)).toMatchObject({
      pendingSubagent: null, activeTurn: null,
    });
  });

  it('migrates legacy pending child and parent checkpoints into independent terminal emission', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-subagent-legacy-pending-'));
    tempDirs.push(root);
    const first = await createDormantInput(root);
    const parentFixture = await fs.readFile(path.join(SUBAGENT_FIXTURE_DIR, PARENT_FIXTURE_NAME), 'utf8');
    const parentLines = parentFixture.trimEnd().split('\n');
    const parentTerminal = parentLines.pop()!;
    const parentTranscript = await writeTranscriptNamed(first.sessionDir, PARENT_FIXTURE_NAME, parentLines.join('\n') + '\n');
    await processTranscriptOnce(first.input, parentTranscript);
    const childFixture = await fs.readFile(path.join(SUBAGENT_FIXTURE_DIR, CHILD_FIXTURE_NAME), 'utf8');
    const childLines = childFixture.trimEnd().split('\n');
    const childTerminal = childLines.pop()!;
    const childTranscript = await writeTranscriptNamed(first.sessionDir, CHILD_FIXTURE_NAME, childLines.join('\n') + '\n');
    await processTranscriptOnce(first.input, childTranscript);
    const invoke = first.entries.find(entry => entry['event.name'] === 'gen_ai.agent.invoke'
      && entry['gen_ai.tool.call.id'] === 'call-subagent-1')!;
    const parentCheckpoint = transcriptCheckpoint(first.stateStore, parentTranscript);
    const childCheckpoint = transcriptCheckpoint(first.stateStore, childTranscript);
    await fs.appendFile(parentTranscript, parentTerminal + '\n', 'utf8');
    await fs.appendFile(childTranscript, childTerminal + '\n', 'utf8');
    const parentEnd = (await fs.stat(parentTranscript)).size;
    const childEnd = (await fs.stat(childTranscript)).size;
    const childActive = { ...(childCheckpoint.activeTurn as Record<string, unknown>) };
    delete childActive.delegation;
    delete childActive.emittedTraceId;
    first.stateStore.update(`codex-transcript:${childTranscript}`, {
      lastOffset: childEnd,
      extra: { codexTranscript: { ...childCheckpoint, scanOffset: childEnd, activeTurn: null,
        pendingSubagent: {
          turnId: 'child-turn-1', parentThreadId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          parentTurnId: 'parent-turn-1', parentTraceId: invoke.trace_id,
          parentToolCallId: 'call-subagent-1', confidence: 'agent_path',
          terminalEndOffset: childEnd, activeTurn: childActive,
        },
      } },
    });
    first.stateStore.update(`codex-transcript:${parentTranscript}`, {
      lastOffset: parentEnd,
      extra: { codexTranscript: { ...parentCheckpoint, scanOffset: parentEnd,
        pendingFusion: {
          turnId: 'parent-turn-1', parentThreadId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          parentTraceId: invoke.trace_id, terminalEndOffset: parentEnd, children: [{
            parentToolCallId: 'call-subagent-1', parentTraceId: invoke.trace_id,
            spawnedAtMs: Date.parse('2026-08-07T02:00:04.000Z'),
            childThreadId: CHILD_FIXTURES[0].threadId,
          }],
        },
      } },
    });
    await first.stateStore.save();
    const recovered = await createInput(root);
    try {
      await waitFor(() => responsesForTurn(recovered.entries, 'child-turn-1').length === 1);
      await waitFor(() => transcriptCheckpoint(recovered.stateStore, parentTranscript).activeTurn === null);
    } finally { await recovered.input.stop(); }
    expect(responsesForTurn(recovered.entries, 'child-turn-1')[0]).toMatchObject({
      'gen_ai.session.id': CHILD_FIXTURES[0].threadId,
      'gen_ai.turn.id': `${CHILD_FIXTURES[0].threadId}:child-turn-1`,
    });
    expect([...first.entries, ...recovered.entries].filter(entry => entry['event.name'] === 'llm.response'
      && entry['agent.codex.transcript_turn_id'] === 'parent-turn-1')).toHaveLength(2);
    expect(transcriptCheckpoint(recovered.stateStore, parentTranscript)).toMatchObject({ pendingFusion: null });
    expect(transcriptCheckpoint(recovered.stateStore, childTranscript)).toMatchObject({ pendingSubagent: null });
  });

  it('rebuilds owning metadata instead of trusting a legacy latest-meta checkpoint', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-subagent-migration-'));
    tempDirs.push(root);
    const sessionDir = path.join(root, 'sessions');
    const childFixture = await fs.readFile(path.join(SUBAGENT_FIXTURE_DIR, CHILD_FIXTURE_NAME), 'utf8');
    const childLines = childFixture.trimEnd().split('\n');
    const childTranscript = await writeTranscriptNamed(sessionDir, CHILD_FIXTURE_NAME, childFixture);
    const stat = await fs.stat(childTranscript);
    const copiedParentEndOffset = Buffer.byteLength(childLines.slice(0, 9).join('\n') + '\n');
    const copiedParentMetaOffset = Buffer.byteLength(childLines[0] + '\n');
    const persistedState = new StateStore(path.join(root, 'input-state.json'));
    await persistedState.load();
    persistedState.update(`codex-transcript:${childTranscript}`, {
      lastOffset: copiedParentEndOffset,
      extra: {
        codexTranscript: {
          inode: stat.ino,
          scanOffset: copiedParentEndOffset,
          activeTurn: null,
          pendingTerminal: null,
          // This is the pre-fix shape and deliberately points at parent meta.
          latestSessionMetaOffset: copiedParentMetaOffset,
          emittedTerminalTurnIds: ['parent-turn-1'],
        },
      },
    });
    await persistedState.save();

    const recovered = await createInput(root);
    await waitFor(() => responsesForTurn(recovered.entries, 'child-turn-1').length === 1);
    await recovered.input.stop();

    expect(responsesForTurn(recovered.entries, 'child-turn-1')).toHaveLength(1);
    expect(transcriptCheckpoint(recovered.stateStore, childTranscript)).toMatchObject({
      ownerSessionMetaOffset: 0,
      pendingSubagent: null,
      activeTurn: null,
    });
  });

  it('skips copied parent terminals whose line timestamps were rewritten at fork time', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-subagent-rewritten-time-'));
    tempDirs.push(root);
    const { input, entries, sessionDir, stateStore } = await createInput(root);
    const fixture = await fs.readFile(path.join(SUBAGENT_FIXTURE_DIR, CHILD_FIXTURE_NAME), 'utf8');
    const parentTurnId = '019fdb63-2fc6-7491-9895-8c8f86a8bcab';
    const childTurnId = '019fdb63-714b-7c72-9c8c-c2e40d9c9111';
    const lines = fixture.trimEnd().split('\n').map((line, index) => {
      const parsed = JSON.parse(line) as { timestamp: string; payload: Record<string, unknown> };
      if (index === 0) {
        parsed.timestamp = '2026-08-07T08:42:35.146Z';
        parsed.payload.timestamp = parsed.timestamp;
        parsed.payload.id = '019fdb63-710a-7131-978c-6a6ee744fff9';
      }
      if (index >= 1 && index <= 8) parsed.timestamp = '2026-08-07T08:42:35.204Z';
      return JSON.stringify(parsed)
        .replaceAll('parent-turn-1', parentTurnId)
        .replaceAll('child-turn-1', childTurnId);
    });
    const transcript = await writeTranscriptNamed(
      sessionDir,
      CHILD_FIXTURE_NAME,
      lines.join('\n') + '\n',
    );

    await waitFor(() => responsesForTurn(entries, childTurnId).length === 1);
    await input.stop();

    expect(transcriptCheckpoint(stateStore, transcript)).toMatchObject({
      pendingSubagent: null,
      activeTurn: null,
    });
  });

  it('skips the copied prefix when child metadata has no creation timestamp', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-subagent-turn-owner-'));
    tempDirs.push(root);
    const { input, entries, sessionDir, stateStore } = await createInput(root);
    const parentThreadId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const childThreadId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const parentTurnId = 'copied-parent-turn';
    const childTurnId = 'owned-child-turn';
    const parentMeta = record('2026-08-07T02:00:00.000Z', 'session_meta', {
      id: parentThreadId,
      session_id: parentThreadId,
      source: 'vscode',
      thread_source: 'user',
      model_provider: 'openai',
    });
    await writeTranscriptNamed(sessionDir, PARENT_FIXTURE_NAME, [
      parentMeta,
      record('2026-08-07T02:00:01.000Z', 'turn_context', {
        turn_id: parentTurnId, model: 'gpt-test',
      }),
      record('2026-08-07T02:00:02.000Z', 'event_msg', {
        type: 'task_started', turn_id: parentTurnId,
      }),
    ].join('\n') + '\n');

    const childMeta = JSON.stringify({
      type: 'session_meta',
      payload: {
        id: childThreadId,
        session_id: parentThreadId,
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: parentThreadId,
              depth: 1,
              agent_path: '/root/fixture_child',
            },
          },
        },
        thread_source: 'subagent',
        model_provider: 'openai',
        multi_agent_version: 'v2',
      },
    });
    const childTranscript = await writeTranscriptNamed(sessionDir, CHILD_FIXTURE_NAME, [
      childMeta,
      parentMeta,
      record('2026-08-07T02:00:03.000Z', 'turn_context', {
        turn_id: parentTurnId, model: 'gpt-test',
      }),
      record('2026-08-07T02:00:04.000Z', 'event_msg', {
        type: 'task_started', turn_id: parentTurnId,
      }),
      record('2026-08-07T02:00:05.000Z', 'event_msg', {
        type: 'task_complete', turn_id: parentTurnId,
      }),
      record('2026-08-07T02:00:06.000Z', 'turn_context', {
        turn_id: childTurnId, model: 'gpt-test',
      }),
      record('2026-08-07T02:00:07.000Z', 'event_msg', {
        type: 'task_started', turn_id: childTurnId,
      }),
      record('2026-08-07T02:00:08.000Z', 'response_item', {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: 'child task' }],
      }),
      record('2026-08-07T02:00:09.000Z', 'event_msg', {
        type: 'agent_message', message: 'child done', phase: 'final',
      }),
      record('2026-08-07T02:00:10.000Z', 'event_msg', {
        type: 'task_complete', turn_id: childTurnId,
      }),
    ].join('\n') + '\n');

    await waitFor(() => responsesForTurn(entries, childTurnId).length === 1);
    await input.stop();

    expect(responsesForTurn(entries, parentTurnId)).toHaveLength(0);
    expect(responsesForTurn(entries, childTurnId)).toHaveLength(1);
    expect(transcriptCheckpoint(stateStore, childTranscript)).toMatchObject({
      activeTurn: null,
      pendingTerminal: null,
    });
  });

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

  it('prefers token_usage_record response_id over response item ids', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-response-id-'));
    tempDirs.push(root);
    const { input, entries, sessionDir } = await createInput(root);
    await writeTranscript(sessionDir, [
      record('2026-06-24T06:00:00.000Z', 'session_meta', { id: 'session-1', model_provider: 'openai' }),
      record('2026-06-24T06:00:01.000Z', 'turn_context', { turn_id: 'turn-1', model: 'gpt-5.5' }),
      record('2026-06-24T06:00:02.000Z', 'event_msg', { type: 'task_started', turn_id: 'turn-1' }),
      record('2026-06-24T06:00:03.000Z', 'response_item', {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: 'check it' }],
      }),
      record('2026-06-24T06:00:04.000Z', 'response_item', {
        type: 'reasoning', id: 'rs-provider-item', summary: [], content: null, encrypted_content: null,
      }),
      record('2026-06-24T06:00:05.000Z', 'response_item', {
        type: 'message', id: 'msg-provider-item', role: 'assistant',
        content: [{ type: 'output_text', text: 'done' }],
      }),
      record('2026-06-24T06:00:06.000Z', 'token_usage_record', {
        thread_id: 'session-1', turn_id: 'turn-1', session_id: 'session-1',
        response_id: 'resp-provider-response',
        usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
      }),
      record('2026-06-24T06:00:07.000Z', 'event_msg', tokenUsage(100, 10)),
      record('2026-06-24T06:00:08.000Z', 'event_msg', {
        type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'done',
      }),
    ].join('\n') + '\n');

    await waitFor(() => entries.some(entry => entry['event.name'] === 'llm.response'));
    await input.stop();

    const request = entries.find(entry => entry['event.name'] === 'llm.request');
    const response = entries.find(entry => entry['event.name'] === 'llm.response');
    expect(request?.['gen_ai.response.id']).toBe('resp-provider-response');
    expect(response?.['gen_ai.response.id']).toBe('resp-provider-response');
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

  it('projects turn-scoped invocation attributes onto every Codex record', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-span-context-'));
    tempDirs.push(root);
    const { input, entries, sessionDir, spanContextDir } = await createInput(root);
    await writeSpanContext(spanContextDir, 'session-1', 'turn-1', {
      session_id: 'session-1',
      turn_id: 'turn-1',
      spanAttributes: {
        'multica.issue.id': 'issue-1',
        'multica.agent.name': 'codex-agent',
        'multica.runtime.name': 'codex',
      },
      received_at: new Date().toISOString(),
    });
    await writeTranscript(sessionDir, completedTurn());

    await waitFor(() => entries.filter(entry => entry['event.name'] === 'llm.response').length === 3);
    await input.stop();

    expect(new Set(entries.map(entry => entry['event.name']))).toEqual(new Set([
      'other',
      'llm.request',
      'llm.response',
      'tool.call',
      'tool.result',
    ]));
    for (const entry of entries) {
      expect(entry['multica.issue.id']).toBe('issue-1');
      expect(entry['multica.agent.name']).toBe('codex-agent');
      expect(entry['multica.runtime.name']).toBe('codex');
    }
  });

  it('keeps invocation attributes isolated by turn within one Codex session', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-span-isolation-'));
    tempDirs.push(root);
    const { input, entries, sessionDir, spanContextDir } = await createInput(root);
    await writeSpanContext(spanContextDir, 'session-1', 'turn-1', {
      session_id: 'session-1',
      turn_id: 'turn-1',
      spanAttributes: { 'multica.issue.id': 'issue-1' },
      received_at: new Date().toISOString(),
    });
    await writeSpanContext(spanContextDir, 'session-1', 'turn-2', {
      session_id: 'session-1',
      turn_id: 'turn-2',
      spanAttributes: { 'multica.issue.id': 'issue-2' },
      received_at: new Date().toISOString(),
    });
    await writeTranscriptNamed(
      sessionDir,
      'rollout-session-1.jsonl',
      [
        ...simpleCompletedTurn(
          'session-1', 'turn-1', 'first issue', 'first completed', 100, 10,
          '2026-06-24T06:00:00.000Z',
        ),
        ...simpleCompletedTurn(
          'session-1', 'turn-2', 'second issue', 'second completed', 120, 12,
          '2026-06-24T06:01:00.000Z',
        ).slice(1),
      ].join('\n') + '\n',
    );

    await waitFor(() => responsesForTurn(entries, 'turn-2').length === 1);
    await input.stop();

    const firstTurnEntries = entries.filter(entry =>
      entry['agent.codex.transcript_turn_id'] === 'turn-1');
    const secondTurnEntries = entries.filter(entry =>
      entry['agent.codex.transcript_turn_id'] === 'turn-2');
    expect(firstTurnEntries.length).toBeGreaterThan(0);
    expect(secondTurnEntries.length).toBeGreaterThan(0);
    expect(new Set(firstTurnEntries.map(entry => entry['multica.issue.id']))).toEqual(new Set(['issue-1']));
    expect(new Set(secondTurnEntries.map(entry => entry['multica.issue.id']))).toEqual(new Set(['issue-2']));
  });

  it('defensively filters invalid invocation attributes from span contexts', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-span-filter-'));
    tempDirs.push(root);
    const { input, entries, sessionDir, spanContextDir } = await createInput(root);
    const longValue = 'x'.repeat(513);
    await writeSpanContext(spanContextDir, 'session-1', 'turn-1', {
      session_id: 'session-1',
      turn_id: 'turn-1',
      spanAttributes: {
        'multica.issue.id': ' issue-1 ',
        'gen_ai.agent.name': 'must-not-overwrite',
        'multica.api_token': 'must-not-leak',
        'multica.long': longValue,
        'multica.number': 42,
      },
      received_at: new Date().toISOString(),
    });
    await writeTranscript(sessionDir, completedTurn());

    await waitFor(() => entries.filter(entry => entry['event.name'] === 'llm.response').length === 3);
    await input.stop();

    for (const entry of entries) {
      expect(entry['multica.issue.id']).toBe('issue-1');
      expect(entry['gen_ai.agent.name']).not.toBe('must-not-overwrite');
      expect(entry['multica.api_token']).toBeUndefined();
      expect(entry['multica.long']).toBeUndefined();
      expect(entry['multica.number']).toBeUndefined();
    }
    expect(JSON.stringify(entries)).not.toContain('must-not-leak');
    expect(JSON.stringify(entries)).not.toContain(longValue);
  });

  it('rejects a span context whose payload identifiers do not match its file name', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-span-mismatch-'));
    tempDirs.push(root);
    const { input, entries, sessionDir, spanContextDir } = await createInput(root);
    await writeSpanContext(spanContextDir, 'session-1', 'turn-1', {
      session_id: 'different-session',
      turn_id: 'turn-1',
      spanAttributes: { 'multica.issue.id': 'wrong-issue' },
      received_at: new Date().toISOString(),
    });
    await writeTranscript(sessionDir, completedTurn());

    await waitFor(() => entries.filter(entry => entry['event.name'] === 'llm.response').length === 3);
    await input.stop();

    expect(entries.every(entry => entry['multica.issue.id'] === undefined)).toBe(true);
  });

  it('removes expired turn span contexts with bounded cleanup', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-span-cleanup-'));
    tempDirs.push(root);
    const { input, spanContextDir } = await createDormantInput(root);
    const marker = await writeSpanContext(spanContextDir, 'session-1', 'turn-1', {
      session_id: 'session-1',
      turn_id: 'turn-1',
      spanAttributes: { 'multica.issue.id': 'expired-issue' },
      received_at: new Date(Date.now() - 49 * 60 * 60 * 1_000).toISOString(),
    });

    await (input as unknown as {
      cleanupExpiredSpanContexts(now: number): Promise<void>;
    }).cleanupExpiredSpanContexts(Date.now());

    await expect(fs.access(marker)).rejects.toThrow();
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

  it('discovers and ingests a task-scoped CODEX_HOME before a Stop hook', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-dynamic-home-'));
    tempDirs.push(root);
    const { input, entries, wakeupDir, stateStore } = await createDormantInput(root);
    const codexHome = path.join(root, 'multica-task', 'codex-home');
    const dynamicSessionDir = path.join(codexHome, 'sessions');
    const transcriptText = completedTurn().replace('"type":"task_complete"', '"type":"turn_aborted"');
    const transcript = await writeTranscript(dynamicSessionDir, transcriptText);
    await writeWakeupMarker(wakeupDir, 'session-1', {
      session_id: 'session-1',
      turn_id: 'turn-1',
      codex_home: codexHome,
      received_at: new Date().toISOString(),
    });

    await input.start();
    await waitFor(() => entries.some(entry => entry['event.name'] === 'tool.result'));
    await input.stop();

    const canonicalTranscript = await fs.realpath(transcript);
    expect(entries.some(entry => entry['event.name'] === 'llm.response')).toBe(true);
    expect(entries.some(entry => entry['agent.codex.transcript_turn_id'] === 'turn-1')).toBe(true);
    expect(transcriptCheckpoint(stateStore, canonicalTranscript).scanOffset)
      .toBe(Buffer.byteLength(transcriptText));
  });

  it('discovers a CODEX_HOME user-isolated session directory from transcript_path', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-user-home-'));
    tempDirs.push(root);
    const { input, entries, wakeupDir, stateStore } = await createDormantInput(root);
    const codexHome = path.join(root, 'codex-home');
    const isolatedSessionDir = path.join(codexHome, 'u', 'd4bb12dfd37d67c70484b62e0ed31509', 'sessions');
    const transcriptText = completedTurn();
    const transcript = await writeTranscript(isolatedSessionDir, transcriptText);
    await writeWakeupMarker(wakeupDir, 'session-1', {
      session_id: 'session-1',
      turn_id: 'turn-1',
      codex_home: codexHome,
      // Older hook versions still record the legacy root; transcript_path is authoritative.
      session_dir: path.join(codexHome, 'sessions'),
      transcript_path: transcript,
      received_at: new Date().toISOString(),
    });

    await input.start();
    await waitFor(() => entries.some(entry => entry['event.name'] === 'tool.result'));
    await input.stop();

    const canonicalTranscript = await fs.realpath(transcript);
    expect(entries.some(entry => entry['gen_ai.session.id'] === 'session-1')).toBe(true);
    expect(transcriptCheckpoint(stateStore, canonicalTranscript).scanOffset)
      .toBe(Buffer.byteLength(transcriptText));
  });

  it('does not let the default session root consume the dynamic rollout budget', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-dynamic-budget-'));
    tempDirs.push(root);
    const { input, entries, sessionDir, wakeupDir } = await createDormantInput(root);
    await Promise.all(Array.from({ length: 64 }, (_, index) => (
      writeTranscriptNamed(sessionDir, `rollout-default-${index}.jsonl`, '')
    )));

    const codexHome = path.join(root, 'multica-task', 'codex-home');
    const dynamicSessionDir = path.join(codexHome, 'sessions');
    await writeTranscript(dynamicSessionDir, completedTurn());
    const receivedAt = new Date().toISOString();
    await writeWakeupMarker(wakeupDir, 'zzzz-default', {
      session_id: 'default-session',
      session_dir: sessionDir,
      received_at: receivedAt,
    });
    await writeWakeupMarker(wakeupDir, 'aaaa-dynamic', {
      session_id: 'session-1',
      codex_home: codexHome,
      session_dir: dynamicSessionDir,
      received_at: receivedAt,
    });

    await input.start();
    await waitFor(() => entries.some(entry => entry['event.name'] === 'tool.result'));
    await input.stop();

    expect(entries.some(entry => entry['gen_ai.session.id'] === 'session-1')).toBe(true);
  });

  it('does not recurse outside the bounded Codex YYYY/MM/DD session layout', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-dynamic-layout-'));
    tempDirs.push(root);
    const { input, entries, wakeupDir, stateStore } = await createDormantInput(root);
    const dynamicSessionDir = path.join(root, 'dynamic-codex-home', 'sessions');
    const transcript = path.join(
      dynamicSessionDir,
      'unrelated',
      'deep',
      'tree',
      'rollout-session-1.jsonl',
    );
    await fs.mkdir(path.dirname(transcript), { recursive: true });
    await fs.writeFile(transcript, completedTurn(), 'utf8');
    await writeWakeupMarker(wakeupDir, 'session-1', {
      session_id: 'session-1',
      session_dir: dynamicSessionDir,
      received_at: new Date().toISOString(),
    });

    await input.start();
    await input.stop();

    expect(entries).toHaveLength(0);
    expect(stateStore.get(`codex-transcript:${transcript}`).lastOffset).toBeUndefined();
  });

  it('rejects a marker whose session_dir does not match codex_home', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-marker-mismatch-'));
    tempDirs.push(root);
    const { input, entries, wakeupDir, stateStore } = await createDormantInput(root);
    const codexHome = path.join(root, 'expected-codex-home');
    const mismatchedSessionDir = path.join(root, 'unexpected-codex-home', 'sessions');
    const transcript = await writeTranscript(mismatchedSessionDir, completedTurn());
    await writeWakeupMarker(wakeupDir, 'session-1', {
      session_id: 'session-1',
      codex_home: codexHome,
      session_dir: mismatchedSessionDir,
      received_at: new Date().toISOString(),
    });

    await input.start();
    await input.stop();

    expect(entries).toHaveLength(0);
    expect(stateStore.get(`codex-transcript:${transcript}`).lastOffset).toBeUndefined();
  });

  it('selects the newest discovery marker when more than 256 markers exist', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-many-markers-'));
    tempDirs.push(root);
    const { input, entries, wakeupDir } = await createDormantInput(root);
    const dynamicSessionDir = path.join(root, 'newest-codex-home', 'sessions');
    await writeTranscript(dynamicSessionDir, completedTurn());
    await fs.mkdir(wakeupDir, { recursive: true });
    const receivedAt = new Date().toISOString();
    await Promise.all(Array.from({ length: 256 }, (_, index) => (
      fs.writeFile(
        path.join(wakeupDir, `old-${String(index).padStart(3, '0')}.json`),
        JSON.stringify({ session_id: `old-${index}`, received_at: receivedAt }),
        'utf8',
      )
    )));
    await fs.writeFile(path.join(wakeupDir, 'zzzz-newest.json'), JSON.stringify({
      session_id: 'session-1',
      session_dir: dynamicSessionDir,
      received_at: receivedAt,
    }), 'utf8');

    await input.start();
    await waitFor(() => entries.some(entry => entry['event.name'] === 'tool.result'));
    await input.stop();

    expect(entries.some(entry => entry['gen_ai.session.id'] === 'session-1')).toBe(true);
  });

  it('ignores expired dynamic CODEX_HOME discovery markers', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-stale-marker-'));
    tempDirs.push(root);
    const { input, entries, wakeupDir, stateStore } = await createDormantInput(root);
    const dynamicSessionDir = path.join(root, 'stale-codex-home', 'sessions');
    const transcript = await writeTranscript(dynamicSessionDir, completedTurn());
    await writeWakeupMarker(wakeupDir, 'session-1', {
      session_id: 'session-1',
      session_dir: dynamicSessionDir,
      received_at: new Date(Date.now() - 49 * 60 * 60 * 1_000).toISOString(),
    });

    await input.start();
    await input.stop();

    expect(entries).toHaveLength(0);
    expect(stateStore.get(`codex-transcript:${await fs.realpath(transcript)}`).lastOffset).toBeUndefined();
    await expect(fs.access(path.join(wakeupDir, 'session-1.json'))).rejects.toThrow();
  });

  it('ignores inactive rollout files under a freshly discovered CODEX_HOME', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-inactive-rollout-'));
    tempDirs.push(root);
    const { input, entries, wakeupDir, stateStore } = await createDormantInput(root);
    const dynamicSessionDir = path.join(root, 'inactive-codex-home', 'sessions');
    const transcript = await writeTranscript(dynamicSessionDir, completedTurn());
    const inactiveAt = new Date(Date.now() - 16 * 60 * 1_000);
    await fs.utimes(transcript, inactiveAt, inactiveAt);
    await writeWakeupMarker(wakeupDir, 'session-1', {
      session_id: 'session-1',
      session_dir: dynamicSessionDir,
      received_at: new Date().toISOString(),
    });

    await input.start();
    await input.stop();

    expect(entries).toHaveLength(0);
    expect(stateStore.get(`codex-transcript:${await fs.realpath(transcript)}`).lastOffset).toBeUndefined();
  });

  it('continues to baseline transcripts already present in the default session directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-default-baseline-'));
    tempDirs.push(root);
    const { input, entries, sessionDir, stateStore } = await createDormantInput(root);
    const transcriptText = completedTurn();
    const transcript = await writeTranscript(sessionDir, transcriptText);

    await input.start();
    await input.stop();

    expect(entries).toHaveLength(0);
    expect(transcriptCheckpoint(stateStore, transcript).scanOffset)
      .toBe(Buffer.byteLength(transcriptText));
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
      forkBootstrap?: unknown;
    };
    expect(checkpoint.activeTurn).toBeNull();
    expect(checkpoint.pendingTerminal).toBeNull();
    expect(checkpoint.forkBootstrap).toBeUndefined();
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
      forkBootstrap?: unknown;
    };
    expect(checkpoint.scanOffset).toBe((await fs.stat(transcript)).size);
    expect(checkpoint.activeTurn).toBeNull();
    expect(checkpoint.pendingTerminal).toBeNull();
    expect(checkpoint.forkBootstrap).toBeUndefined();
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

  it('skips copied history and emits new fork work in one cycle', async () => {
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
      forkBootstrap?: unknown;
    };
    expect(checkpoint.activeTurn).toBeNull();
    expect(checkpoint.pendingTerminal).toBeNull();
    expect(checkpoint.forkBootstrap).toBeUndefined();

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
    expect(transcriptCheckpoint(restarted.stateStore, secondFork)).toMatchObject({
      activeTurn: null,
      pendingTerminal: null,
    });
    expect(transcriptCheckpoint(restarted.stateStore, secondFork).forkBootstrap).toBeUndefined();
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
      forkBootstrap?: unknown;
    };
    expect(checkpoint.activeTurn).toBeNull();
    expect(checkpoint.pendingTerminal).toBeNull();
    expect(checkpoint.forkBootstrap).toBeUndefined();
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
      spanContextDir: path.join(root, 'span-contexts'),
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

  it('does not suppress matching turn IDs across independent transcript files', async () => {
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

    expect(responsesForTurn(entries, 'turn-1')).toHaveLength(2);
    expect(responsesForTurn(entries, 'turn-2')).toHaveLength(1);
    expect(responsesForTurn(entries, 'turn-1')[0]?.['gen_ai.usage.total_tokens']).toBe(110);
    expect(responsesForTurn(entries, 'turn-2')[0]?.['gen_ai.usage.total_tokens']).toBe(132);
  });

  it('does not restore cross-transcript turn-ID suppression after restart', async () => {
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
    const debug = vi.fn();
    (restarted.input as unknown as { logger: { debug: typeof debug } }).logger.debug = debug;
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

    expect(responsesForTurn(restarted.entries, 'turn-1')).toHaveLength(1);
    expect(responsesForTurn(restarted.entries, 'turn-2')).toHaveLength(1);
    expect(responsesForTurn(restarted.entries, 'turn-2')[0]?.['gen_ai.usage.total_tokens']).toBe(132);
    expect(debug).not.toHaveBeenCalledWith(
      'skipped terminal Codex turn already present in global registry',
      expect.anything(),
    );
  });

  it('does not let an inode baseline suppress matching IDs in another transcript', async () => {
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

    expect(responsesForTurn(restarted.entries, 'turn-2')).toHaveLength(1);
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
    // This test drives processFile directly; keep the background poller dormant
    // so it cannot race the explicit collection cycles below.
    const { input, entries, sessionDir, stateStore } = await createDormantInput(root);
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
    expect(responses[0]?.['agent.codex.turn_status']).toBeUndefined();
    expect(entries).toContainEqual(expect.objectContaining({
      'event.name': 'other',
      'gen_ai.turn.end': true,
    }));
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

  it('restores the next-wave time anchor and suppresses repeated cumulative token snapshots', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-wave-continuation-'));
    tempDirs.push(root);
    const first = await createDormantInput(root);
    const initialWave = [
      record('2026-06-24T06:00:00.000Z', 'session_meta', { id: 'session-1', model_provider: 'openai' }),
      record('2026-06-24T06:00:01.000Z', 'turn_context', { turn_id: 'turn-1', model: 'gpt-5.5' }),
      record('2026-06-24T06:00:02.000Z', 'event_msg', { type: 'task_started', turn_id: 'turn-1' }),
      record('2026-06-24T06:00:03.000Z', 'response_item', {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: 'coordinate work' }],
      }),
      record('2026-06-24T06:00:04.000Z', 'response_item', {
        type: 'function_call', call_id: 'call-spawn', name: 'spawn_agent', arguments: '{}',
      }),
      record('2026-06-24T06:00:05.000Z', 'response_item', {
        type: 'function_call_output', call_id: 'call-spawn', output: '{}',
      }),
      record('2026-06-24T06:00:05.100Z', 'event_msg', tokenUsage(10, 2, 1_000)),
    ];
    const transcript = await writeTranscript(first.sessionDir, initialWave.join('\n') + '\n');

    await processTranscriptOnce(first.input, transcript);
    await first.stateStore.save();
    expect(transcriptCheckpoint(first.stateStore, transcript)).toMatchObject({
      activeTurn: {
        nextStepStartedAtMs: Date.parse('2026-06-24T06:00:05.100Z'),
        lastCumulativeTokenTotal: 1_000,
      },
    });

    const second = await createDormantInput(root);
    await fs.appendFile(transcript, [
      record('2026-06-24T06:00:08.000Z', 'response_item', {
        type: 'function_call', call_id: 'call-wait', name: 'wait_agent', arguments: '{}',
      }),
      record('2026-06-24T06:00:09.000Z', 'response_item', {
        type: 'function_call_output', call_id: 'call-wait', output: '{}',
      }),
      record('2026-06-24T06:00:09.100Z', 'event_msg', tokenUsage(20, 2, 1_100)),
    ].join('\n') + '\n', 'utf8');
    await processTranscriptOnce(second.input, transcript);
    await second.stateStore.save();

    const third = await createDormantInput(root);
    await fs.appendFile(transcript, [
      record('2026-06-24T06:00:12.000Z', 'event_msg', {
        type: 'agent_message', message: 'continuing after wait', phase: 'commentary',
      }),
      // Codex may write the unchanged accounting snapshot again with a later message.
      record('2026-06-24T06:00:12.100Z', 'event_msg', tokenUsage(20, 2, 1_100)),
      record('2026-06-24T06:00:13.000Z', 'event_msg', {
        type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'continuing after wait',
      }),
    ].join('\n') + '\n', 'utf8');
    await processTranscriptOnce(third.input, transcript);

    const allEntries = [...first.entries, ...second.entries, ...third.entries];
    const responses = allEntries.filter(entry => entry['event.name'] === 'llm.response');
    expect(responses.map(entry => entry['gen_ai.usage.total_tokens'])).toEqual([12, 22, 0]);
    expect(responses.filter(entry => entry['gen_ai.usage.total_tokens'] === 22)).toHaveLength(1);

    for (const stepNumber of [2, 3]) {
      const stepId = `session-1:turn-1:s${stepNumber}`;
      const request = allEntries.find(entry => entry['event.name'] === 'llm.request'
        && entry['gen_ai.step.id'] === stepId)!;
      const response = allEntries.find(entry => entry['event.name'] === 'llm.response'
        && entry['gen_ai.step.id'] === stepId)!;
      expect(entryTimestampMs(response)).toBeGreaterThan(entryTimestampMs(request));
    }
  });

  it('attributes a later fresh sample to the wave a repeated snapshot left open', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-stale-then-fresh-'));
    tempDirs.push(root);
    const { input, entries, sessionDir } = await createDormantInput(root);
    const lines = [
      record('2026-06-24T06:00:00.000Z', 'session_meta', { id: 'session-1', model_provider: 'openai' }),
      record('2026-06-24T06:00:01.000Z', 'turn_context', { turn_id: 'turn-1', model: 'gpt-5.5' }),
      record('2026-06-24T06:00:02.000Z', 'event_msg', { type: 'task_started', turn_id: 'turn-1' }),
      record('2026-06-24T06:00:03.000Z', 'response_item', {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run it' }],
      }),
      record('2026-06-24T06:00:04.000Z', 'event_msg', {
        type: 'agent_message', message: 'A', phase: 'commentary',
      }),
      record('2026-06-24T06:00:05.000Z', 'event_msg', tokenUsage(10, 2, 1_000)),
      record('2026-06-24T06:00:06.000Z', 'event_msg', {
        type: 'agent_message', message: 'B', phase: 'final',
      }),
      // Stale repeat of the wave-1 accounting: it must not close wave 2.
      record('2026-06-24T06:00:07.000Z', 'event_msg', tokenUsage(10, 2, 1_000)),
      // Fresh accounting for wave 2; it has to land on the still-open wave.
      record('2026-06-24T06:00:08.000Z', 'event_msg', tokenUsage(20, 2, 1_100)),
      record('2026-06-24T06:00:09.000Z', 'event_msg', {
        type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'B',
      }),
    ];
    const transcript = await writeTranscript(sessionDir, lines.join('\n') + '\n');

    await processTranscriptOnce(input, transcript);
    await input.stop();

    const responses = entries.filter(entry => entry['event.name'] === 'llm.response');
    expect(responses.map(entry => entry['gen_ai.step.id'])).toEqual([
      'session-1:turn-1:s1',
      'session-1:turn-1:s2',
    ]);
    expect(responses.map(entry => entry['gen_ai.usage.total_tokens'])).toEqual([12, 22]);
  });

  it('keeps a wave opened by a repeated snapshot collectable across a restart', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-stale-then-fresh-restart-'));
    tempDirs.push(root);
    const first = await createDormantInput(root);
    const head = [
      record('2026-06-24T06:00:00.000Z', 'session_meta', { id: 'session-1', model_provider: 'openai' }),
      record('2026-06-24T06:00:01.000Z', 'turn_context', { turn_id: 'turn-1', model: 'gpt-5.5' }),
      record('2026-06-24T06:00:02.000Z', 'event_msg', { type: 'task_started', turn_id: 'turn-1' }),
      record('2026-06-24T06:00:03.000Z', 'response_item', {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run it' }],
      }),
      record('2026-06-24T06:00:04.000Z', 'event_msg', {
        type: 'agent_message', message: 'A', phase: 'commentary',
      }),
      record('2026-06-24T06:00:05.000Z', 'event_msg', tokenUsage(10, 2, 1_000)),
      record('2026-06-24T06:00:06.000Z', 'event_msg', {
        type: 'agent_message', message: 'B', phase: 'final',
      }),
      record('2026-06-24T06:00:07.000Z', 'event_msg', tokenUsage(10, 2, 1_000)),
    ];
    const transcript = await writeTranscript(first.sessionDir, head.join('\n') + '\n');

    await processTranscriptOnce(first.input, transcript);
    await first.stateStore.save();
    // Wave 2 still awaits its own accounting, so only wave 1 may be emitted.
    expect(first.entries.filter(entry => entry['event.name'] === 'llm.response'))
      .toHaveLength(1);
    expect(transcriptCheckpoint(first.stateStore, transcript)).toMatchObject({
      activeTurn: { lastCumulativeTokenTotal: 1_000 },
    });

    const second = await createDormantInput(root);
    await fs.appendFile(transcript, [
      record('2026-06-24T06:00:10.000Z', 'event_msg', tokenUsage(20, 2, 1_100)),
      record('2026-06-24T06:00:11.000Z', 'event_msg', {
        type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'B',
      }),
    ].join('\n') + '\n', 'utf8');
    await processTranscriptOnce(second.input, transcript);
    await second.input.stop();

    const allEntries = [...first.entries, ...second.entries];
    const responses = allEntries.filter(entry => entry['event.name'] === 'llm.response');
    expect(responses.map(entry => entry['gen_ai.step.id'])).toEqual([
      'session-1:turn-1:s1',
      'session-1:turn-1:s2',
    ]);
    expect(responses.map(entry => entry['gen_ai.usage.total_tokens'])).toEqual([12, 22]);
  });

  it('does not commit a tool wave until an output written after token_count is present', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-token-before-tool-output-'));
    tempDirs.push(root);
    // This test drives processFile directly, so keep the normal watcher/poll
    // cycle dormant to avoid racing a second collection of the same append.
    const { input, entries, sessionDir } = await createDormantInput(root);
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

    expect(entries.filter(entry => entry['event.name'] === 'llm.response')).toHaveLength(1);
    expect(entries.filter(entry => entry['event.name'] === 'tool.call')).toHaveLength(1);
    expect(entries.filter(entry => entry['event.name'] === 'tool.result')).toHaveLength(1);
    expect(entries.find(entry => entry['event.name'] === 'tool.result')).toMatchObject({
      'gen_ai.tool.call.id': 'call-1',
      'gen_ai.tool.call.result': '/tmp',
    });
  });

  it.each(['completed', 'interrupted'] as const)('keeps the %s marker identity and native terminal time across segmented and terminal-only recovery', async status => {
    const original = completedTurn().trimEnd().split('\n');
    const terminalAt = '2026-06-24T06:30:00.000Z';
    original[original.length - 1] = record(terminalAt, 'event_msg', {
      type: status === 'completed' ? 'task_complete' : 'turn_aborted',
      turn_id: 'turn-1', ...(status === 'completed' ? { last_agent_message: 'fixed' } : { reason: 'user interruption' }),
    });
    const prefix = original.slice(0, -1).join('\n') + '\n';
    const complete = original.join('\n') + '\n';
    const markers: AgentActivityEntry[] = [];
    for (const mode of ['full', 'segmented', 'terminal-only'] as const) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), `codex-terminal-${mode}-`));
      tempDirs.push(root);
      const { input, entries, sessionDir, stateStore } = await createDormantInput(root);
      const transcript = await writeTranscript(sessionDir, mode === 'segmented' ? prefix : complete);
      if (mode === 'terminal-only') {
        const inode = (await fs.stat(transcript)).ino;
        stateStore.update(`codex-transcript:${transcript}`, {
          extra: { codexTranscript: {
            inode, scanOffset: Buffer.byteLength(complete), ownerSessionMetaOffset: 0,
            activeTurn: { turnId: 'turn-1', startOffset: Buffer.byteLength(prefix),
              startedAtMs: Date.parse('2026-06-24T06:00:02.000Z'), emittedPrompt: true, emittedStepCount: 3,
              emittedTraceId: markers[0]!.trace_id, model: 'gpt-5.5', cwd: '/tmp/project' },
            pendingTerminal: { turnId: 'turn-1', terminalEndOffset: Buffer.byteLength(complete) },
            pendingFusion: null, pendingSubagent: null,
          } },
        });
      }
      await processTranscriptOnce(input, transcript);
      if (mode === 'segmented') {
        expect(entries.some(entry => entry['gen_ai.turn.end'] === true)).toBe(false);
        await fs.appendFile(transcript, original.at(-1)! + '\n', 'utf8');
        await processTranscriptOnce(input, transcript);
      }
      const marker = entries.filter(entry => entry['gen_ai.turn.end'] === true);
      expect(marker).toHaveLength(1);
      expect(entryTimestampMs(marker[0]!)).toBe(Date.parse(terminalAt));
      expect(marker[0]!['agent.codex.turn_status']).toBe(status);
      markers.push(marker[0]!);
    }
    expect(new Set(markers.map(entry => entry['event.id'])).size).toBe(1);
    expect(new Set(markers.map(entry => entry.span_id)).size).toBe(1);
    expect(markers[0]!.span_id).toMatch(/^[0-9a-f]{16}$/);
    expect(new Set(markers.map(entry => entry['gen_ai.turn.id']))).toEqual(new Set(['session-1:turn-1']));
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
    expect(restarted.entries.find(entry => entry['gen_ai.turn.end'] === true)).toMatchObject({
      'agent.codex.cwd': '/tmp/project',
    });
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

  it('waits for the submitted user message before emitting a prompt assembled across scans', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-prompt-ready-'));
    tempDirs.push(root);
    const { input, entries, sessionDir, stateStore } = await createDormantInput(root);
    const environmentContext = '<environment_context>\n  <cwd>C:\\project</cwd>\n</environment_context>';
    const initial = [
      record('2026-06-24T06:00:00.000Z', 'session_meta', {
        id: 'session-1', model_provider: 'openai',
      }),
      record('2026-06-24T06:00:01.000Z', 'event_msg', {
        type: 'task_started', turn_id: 'turn-1',
      }),
      record('2026-06-24T06:00:01.100Z', 'response_item', {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: environmentContext }],
      }),
      record('2026-06-24T06:00:01.200Z', 'turn_context', {
        turn_id: 'turn-1', model: 'gpt-5.5', cwd: 'C:\\project',
      }),
    ];
    const transcript = await writeTranscript(sessionDir, initial.join('\n') + '\n');

    await processTranscriptOnce(input, transcript);

    expect(entries).toHaveLength(0);
    expect((transcriptCheckpoint(stateStore, transcript) as {
      activeTurn?: { emittedPrompt?: boolean };
    }).activeTurn?.emittedPrompt).not.toBe(true);

    await fs.appendFile(transcript, [
      record('2026-06-24T06:00:01.700Z', 'response_item', {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '修复 Windows 采集' }],
      }),
      record('2026-06-24T06:00:01.710Z', 'event_msg', {
        type: 'user_message', message: '修复 Windows 采集',
      }),
    ].join('\n') + '\n', 'utf8');
    await processTranscriptOnce(input, transcript);
    await processTranscriptOnce(input, transcript);

    const promptEntries = entries.filter(entry => entry['event.name'] === 'other');
    expect(promptEntries).toHaveLength(1);
    expect(promptEntries[0]).toMatchObject({
      'gen_ai.input.messages_delta': [{
        role: 'user',
        parts: [{ type: 'text', content: `${environmentContext}\n修复 Windows 采集` }],
      }],
    });
    expect((transcriptCheckpoint(stateStore, transcript) as {
      activeTurn?: { emittedPrompt?: boolean };
    }).activeTurn?.emittedPrompt).toBe(true);
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

  // ── Copied fork/subagent history prefix must be dropped ──────────────────
  describe('copied history prefix', () => {
    // Build one emittable turn (produces an llm.response) at the given base time.
    const turnBlock = (turnId: string, baseIso: string): string[] => {
      const base = Date.parse(baseIso);
      const at = (s: number) => new Date(base + s * 1000).toISOString();
      return [
        record(at(0), 'turn_context', { turn_id: turnId, model: 'gpt-5.5', cwd: '/tmp/p' }),
        record(at(1), 'event_msg', { type: 'task_started', turn_id: turnId }),
        record(at(2), 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }),
        record(at(3), 'event_msg', { type: 'agent_message', message: `done-${turnId}`, phase: 'final' }),
        record(at(4), 'event_msg', tokenUsage(100, 10)),
        record(at(5), 'event_msg', { type: 'task_complete', turn_id: turnId, last_agent_message: `done-${turnId}` }),
      ];
    };

    const expectStartupCopiedBaselineNotToPoisonParent = async (
      ownerPayload: (parentThreadId: string) => Record<string, unknown>,
    ): Promise<void> => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-copied-startup-baseline-'));
      tempDirs.push(root);
      const { input, entries, sessionDir, stateStore } = await createDormantInput(root);
      const parent = uuidV7At('2026-08-05T09:00:00.000Z', '000000000041');
      const owner = uuidV7At('2026-08-05T10:00:00.000Z', '000000000042');
      const parentTurn = uuidV7At('2026-08-05T09:30:00.000Z', '000000000043');
      const childTurn = uuidV7At('2026-08-05T10:00:00.010Z', '000000000044');
      const parentMeta = record('2026-08-05T09:00:00.000Z', 'session_meta', {
        id: parent, thread_source: 'user', model_provider: 'openai',
      });
      const parentTranscript = await writeTranscriptNamed(
        sessionDir,
        `rollout-2026-08-05T09-00-00-${parent}.jsonl`,
        [parentMeta, ...turnBlock(parentTurn, '2026-08-05T09:30:00.000Z')].join('\n') + '\n',
        { bootstrapFork: false },
      );
      const parentStat = await fs.stat(parentTranscript);
      const parentScanOffset = Buffer.byteLength(parentMeta + '\n');
      stateStore.update(`codex-transcript:${parentTranscript}`, {
        lastOffset: parentScanOffset,
        extra: {
          codexTranscript: {
            inode: parentStat.ino,
            scanOffset: parentScanOffset,
            activeTurn: null,
            pendingTerminal: null,
            pendingFusion: null,
            pendingSubagent: null,
            ownerSessionMetaOffset: 0,
            emittedTerminalTurnIds: [],
          },
        },
      });

      await writeTranscriptNamed(
        sessionDir,
        `rollout-2026-08-05T10-00-00-${owner}.jsonl`,
        [
          record('2026-08-05T10:00:00.000Z', 'session_meta', {
            id: owner,
            model_provider: 'openai',
            ...ownerPayload(parent),
          }),
          ...turnBlock(parentTurn, '2026-08-05T09:30:00.000Z'),
          ...turnBlock(childTurn, '2026-08-05T10:00:00.010Z'),
        ].join('\n') + '\n',
        { bootstrapFork: false },
      );

      await input.start();
      await input.stop();

      expect(responsesForTurn(entries, parentTurn)).toHaveLength(1);
      expect(responsesForTurn(entries, childTurn)).toHaveLength(0);
    };

    it('does not let a startup-baselined user fork suppress an uncollected parent turn', async () => {
      await expectStartupCopiedBaselineNotToPoisonParent(parentThreadId => ({
        forked_from_id: parentThreadId,
        thread_source: 'user',
      }));
    });

    it('does not let a startup-baselined subagent suppress an uncollected parent turn', async () => {
      await expectStartupCopiedBaselineNotToPoisonParent(parentThreadId => ({
        forked_from_id: parentThreadId,
        thread_source: 'subagent',
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: parentThreadId,
              depth: 1,
            },
          },
        },
      }));
    });

    it('keeps probing after a startup baseline while copied history is still materializing', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-copied-startup-materialize-'));
      tempDirs.push(root);
      const { input, entries, sessionDir, stateStore } = await createDormantInput(root);
      const parent = uuidV7At('2026-08-05T09:00:00.000Z', '000000000061');
      const owner = uuidV7At('2026-08-05T10:00:00.000Z', '000000000062');
      const firstCopiedTurn = uuidV7At('2026-08-05T09:20:00.000Z', '000000000063');
      const laterCopiedTurn = uuidV7At('2026-08-05T09:30:00.000Z', '000000000064');
      const childTurn = uuidV7At('2026-08-05T10:00:00.010Z', '000000000065');
      const transcript = await writeTranscriptNamed(
        sessionDir,
        `rollout-2026-08-05T10-00-00-${owner}.jsonl`,
        [
          record('2026-08-05T10:00:00.000Z', 'session_meta', {
            id: owner, forked_from_id: parent, thread_source: 'user', model_provider: 'openai',
          }),
          ...turnBlock(firstCopiedTurn, '2026-08-05T09:20:00.000Z'),
        ].join('\n') + '\n',
        { bootstrapFork: false },
      );
      const baselineSize = (await fs.stat(transcript)).size;

      await input.start();
      expect(entries).toHaveLength(0);
      expect(transcriptCheckpoint(stateStore, transcript)).toMatchObject({
        scanOffset: baselineSize,
        forkBootstrap: {
          searchOffset: expect.any(Number),
        },
      });
      // Subsequent calls intentionally drive processFile directly. Stop the
      // public lifecycle first so its serialized collection cycle cannot race
      // the test-only direct invocation and manufacture duplicate emissions.
      await input.stop();

      await fs.appendFile(transcript, [
        ...turnBlock(laterCopiedTurn, '2026-08-05T09:30:00.000Z'),
        ...turnBlock(childTurn, '2026-08-05T10:00:00.010Z'),
      ].join('\n') + '\n', 'utf8');
      await processTranscriptOnce(input, transcript);

      expect(responsesForTurn(entries, firstCopiedTurn)).toHaveLength(0);
      expect(responsesForTurn(entries, laterCopiedTurn)).toHaveLength(0);
      expect(responsesForTurn(entries, childTurn)).toHaveLength(1);
      expect(transcriptCheckpoint(stateStore, transcript)).toMatchObject({
        activeTurn: null,
        pendingTerminal: null,
      });
      expect(transcriptCheckpoint(stateStore, transcript).forkBootstrap).toBeUndefined();
    });

    it('rebuilds an owned turn that was already active at the startup fork baseline', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-copied-startup-active-tail-'));
      tempDirs.push(root);
      const { input, entries, sessionDir, stateStore } = await createDormantInput(root);
      const parent = uuidV7At('2026-08-05T09:00:00.000Z', '000000000071');
      const owner = uuidV7At('2026-08-05T10:00:00.000Z', '000000000072');
      const copiedTurn = uuidV7At('2026-08-05T09:30:00.000Z', '000000000073');
      const ownedTurn = uuidV7At('2026-08-05T10:00:00.010Z', '000000000074');
      const transcript = await writeTranscriptNamed(
        sessionDir,
        `rollout-2026-08-05T10-00-00-${owner}.jsonl`,
        [
          record('2026-08-05T10:00:00.000Z', 'session_meta', {
            id: owner, forked_from_id: parent, thread_source: 'user', model_provider: 'openai',
          }),
          ...turnBlock(copiedTurn, '2026-08-05T09:30:00.000Z'),
          record('2026-08-05T10:00:00.010Z', 'turn_context', {
            turn_id: ownedTurn, model: 'gpt-5.5', cwd: '/tmp/owned',
          }),
          record('2026-08-05T10:00:01.010Z', 'event_msg', {
            type: 'task_started', turn_id: ownedTurn,
          }),
          record('2026-08-05T10:00:02.010Z', 'response_item', {
            type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue owned turn' }],
          }),
        ].join('\n') + '\n',
        { bootstrapFork: false },
      );
      const baselineSize = (await fs.stat(transcript)).size;

      await input.start();

      expect(entries).toHaveLength(0);
      expect(transcriptCheckpoint(stateStore, transcript)).toMatchObject({
        scanOffset: baselineSize,
        activeTurn: {
          turnId: ownedTurn,
          startOffset: baselineSize,
          model: 'gpt-5.5',
          cwd: '/tmp/owned',
        },
      });
      expect(transcriptCheckpoint(stateStore, transcript).forkBootstrap).toBeUndefined();
      await input.stop();

      await fs.appendFile(transcript, [
        record('2026-08-05T10:00:03.010Z', 'event_msg', {
          type: 'agent_message', message: 'owned result', phase: 'final',
        }),
        record('2026-08-05T10:00:04.010Z', 'event_msg', tokenUsage(100, 10)),
        record('2026-08-05T10:00:05.010Z', 'event_msg', {
          type: 'task_complete', turn_id: ownedTurn, last_agent_message: 'owned result',
        }),
      ].join('\n') + '\n', 'utf8');
      await processTranscriptOnce(input, transcript);

      expect(responsesForTurn(entries, copiedTurn)).toHaveLength(0);
      expect(responsesForTurn(entries, ownedTurn)).toHaveLength(1);
      expect(transcriptCheckpoint(stateStore, transcript)).toMatchObject({
        activeTurn: null,
        pendingTerminal: null,
      });
      expect(transcriptCheckpoint(stateStore, transcript).forkBootstrap).toBeUndefined();
    });

    it('resumes a bounded owned-tail rebuild after restart', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-copied-startup-large-tail-'));
      tempDirs.push(root);
      const first = await createDormantInput(root);
      const parent = uuidV7At('2026-08-05T09:00:00.000Z', '000000000081');
      const owner = uuidV7At('2026-08-05T10:00:00.000Z', '000000000082');
      const copiedTurn = uuidV7At('2026-08-05T09:30:00.000Z', '000000000083');
      const ownedTurn = uuidV7At('2026-08-05T10:00:00.010Z', '000000000084');
      const filler = 'x'.repeat(64 * 1024);
      const ownedTailPadding: string[] = [];
      for (let index = 0; index < 270; index++) {
        ownedTailPadding.push(record('2026-08-05T10:00:03.010Z', 'event_msg', {
          type: 'owned_tail_padding', filler,
        }));
      }
      const transcript = await writeTranscriptNamed(
        first.sessionDir,
        `rollout-2026-08-05T10-00-00-${owner}.jsonl`,
        [
          record('2026-08-05T10:00:00.000Z', 'session_meta', {
            id: owner, forked_from_id: parent, thread_source: 'user', model_provider: 'openai',
          }),
          ...turnBlock(copiedTurn, '2026-08-05T09:30:00.000Z'),
          record('2026-08-05T10:00:00.010Z', 'turn_context', {
            turn_id: ownedTurn, model: 'gpt-5.5', cwd: '/tmp/large-owned',
          }),
          record('2026-08-05T10:00:01.010Z', 'event_msg', {
            type: 'task_started', turn_id: ownedTurn,
          }),
          record('2026-08-05T10:00:02.010Z', 'response_item', {
            type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue large owned turn' }],
          }),
          ...ownedTailPadding,
        ].join('\n') + '\n',
        { bootstrapFork: false },
      );
      const baselineSize = (await fs.stat(transcript)).size;
      expect(baselineSize).toBeGreaterThan(16 * 1024 * 1024);

      await first.input.start();
      const firstCheckpoint = transcriptCheckpoint(first.stateStore, transcript);
      expect(firstCheckpoint).toMatchObject({
        scanOffset: baselineSize,
        activeTurn: null,
        forkBootstrap: {
          state: 'baseline-tail',
          tailCandidate: { turnId: ownedTurn },
        },
      });
      expect((firstCheckpoint.forkBootstrap as { searchOffset: number }).searchOffset)
        .toBeLessThan(baselineSize);
      expect(first.entries).toHaveLength(0);
      await first.stateStore.save();
      await first.input.stop();

      const restarted = await createDormantInput(root);
      await restarted.input.start();
      expect(restarted.entries).toHaveLength(0);
      expect(transcriptCheckpoint(restarted.stateStore, transcript)).toMatchObject({
        scanOffset: baselineSize,
        activeTurn: {
          turnId: ownedTurn,
          startOffset: baselineSize,
          model: 'gpt-5.5',
          cwd: '/tmp/large-owned',
        },
      });
      expect(transcriptCheckpoint(restarted.stateStore, transcript).forkBootstrap).toBeUndefined();
      await restarted.input.stop();

      await fs.appendFile(transcript, [
        record('2026-08-05T10:00:04.010Z', 'event_msg', {
          type: 'agent_message', message: 'large owned result', phase: 'final',
        }),
        record('2026-08-05T10:00:05.010Z', 'event_msg', tokenUsage(100, 10)),
        record('2026-08-05T10:00:06.010Z', 'event_msg', {
          type: 'task_complete', turn_id: ownedTurn, last_agent_message: 'large owned result',
        }),
      ].join('\n') + '\n', 'utf8');
      await processTranscriptOnce(restarted.input, transcript);

      expect(responsesForTurn(restarted.entries, copiedTurn)).toHaveLength(0);
      expect(responsesForTurn(restarted.entries, ownedTurn)).toHaveLength(1);
    }, 30_000);

    it('uses a Hook that arrives before a startup baseline to anchor a later non-UUID turn', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-copied-startup-hook-'));
      tempDirs.push(root);
      const { input, entries, sessionDir, wakeupDir, stateStore } = await createDormantInput(root);
      const parent = 'aaaaaaaa-0061-4061-8061-000000000061';
      const owner = 'cccccccc-0062-4062-8062-000000000062';
      const copiedTurn = 'parent-turn-startup-hook';
      const childTurn = 'child-turn-startup-hook';
      const transcript = await writeTranscriptNamed(
        sessionDir,
        `rollout-2026-08-05T10-00-00-${owner}.jsonl`,
        [
          record('2026-08-05T10:00:00.000Z', 'session_meta', {
            id: owner, forked_from_id: parent, thread_source: 'user', model_provider: 'openai',
          }),
          ...turnBlock(copiedTurn, '2026-08-05T09:20:00.000Z'),
        ].join('\n') + '\n',
        { bootstrapFork: false },
      );
      const baselineSize = (await fs.stat(transcript)).size;
      await writeWakeupMarker(wakeupDir, owner, {
        session_id: owner,
        initial_turn_id: childTurn,
        transcript_path: transcript,
        hook_event: 'user-prompt-submit',
      });

      await input.start();
      expect(entries).toHaveLength(0);
      expect(transcriptCheckpoint(stateStore, transcript)).toMatchObject({
        scanOffset: baselineSize,
        forkBootstrap: { initialTurnId: childTurn },
      });
      await input.stop();

      await fs.appendFile(
        transcript,
        turnBlock(childTurn, '2026-08-05T10:00:00.010Z').join('\n') + '\n',
        'utf8',
      );
      await processTranscriptOnce(input, transcript);
      await processTranscriptOnce(input, transcript);

      expect(responsesForTurn(entries, copiedTurn)).toHaveLength(0);
      expect(responsesForTurn(entries, childTurn)).toHaveLength(1);
      expect(transcriptCheckpoint(stateStore, transcript)).toMatchObject({
        activeTurn: null,
        pendingTerminal: null,
      });
      expect(transcriptCheckpoint(stateStore, transcript).forkBootstrap).toBeUndefined();
    });

    it('keeps a fork rollout pending until an initial-turn Hook arrives', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-copied-await-hook-'));
      tempDirs.push(root);
      const { input, entries, sessionDir, stateStore } = await createDormantInput(root);
      const child = 'cccccccc-0001-4001-8001-000000000001';
      const parent = 'aaaaaaaa-0001-4001-8001-000000000001';
      const transcript = await writeTranscriptNamed(
        sessionDir,
        `rollout-2026-08-05T10-00-00-${child}.jsonl`,
        [
          record('2026-08-05T10:00:00.000Z', 'session_meta', {
            id: child, forked_from_id: parent, thread_source: 'user', model_provider: 'openai',
          }),
          record('2026-06-01T00:00:00.000Z', 'session_meta', { id: parent, model_provider: 'openai' }),
          ...turnBlock('parent-turn-awaiting', '2026-06-01T00:00:10.000Z'),
          ...turnBlock('child-turn-awaiting', '2026-08-05T10:00:10.000Z'),
        ].join('\n') + '\n',
        { bootstrapFork: false },
      );

      await processTranscriptOnce(input, transcript);

      expect(entries).toHaveLength(0);
      expect(transcriptCheckpoint(stateStore, transcript)).toMatchObject({
        scanOffset: 0,
        forkBootstrap: { searchOffset: Buffer.byteLength(await fs.readFile(transcript, 'utf8')) },
      });
    });

    it('uses UUIDv7 causality to collect a same-millisecond first owned turn without any Hook', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-copied-uuid-fallback-'));
      tempDirs.push(root);
      const { input, entries, sessionDir } = await createDormantInput(root);
      const parent = uuidV7At('2026-08-05T09:00:00.000Z');
      const owner = uuidV7At('2026-08-05T10:00:00.000Z', '000000000002');
      const parentTurn = uuidV7At('2026-08-05T09:30:00.000Z');
      const firstOwnedTurn = uuidV7At('2026-08-05T10:00:00.000Z', '000000000003');
      const secondOwnedTurn = uuidV7At('2026-08-05T10:01:00.000Z');
      const transcript = await writeTranscriptNamed(
        sessionDir,
        `rollout-2026-08-05T10-00-00-${owner}.jsonl`,
        [
          record('2026-08-05T10:00:00.000Z', 'session_meta', {
            id: owner, forked_from_id: parent, thread_source: 'user', model_provider: 'openai',
          }),
          record('2026-08-05T09:00:00.000Z', 'session_meta', { id: parent, model_provider: 'openai' }),
          ...turnBlock(parentTurn, '2026-08-05T09:30:00.000Z'),
          ...turnBlock(firstOwnedTurn, '2026-08-05T10:00:00.010Z'),
          ...turnBlock(secondOwnedTurn, '2026-08-05T10:01:00.000Z'),
        ].join('\n') + '\n',
        { bootstrapFork: false },
      );

      await processTranscriptOnce(input, transcript);

      expect(responsesForTurn(entries, parentTurn)).toHaveLength(0);
      expect(responsesForTurn(entries, firstOwnedTurn)).toHaveLength(1);
      expect(responsesForTurn(entries, secondOwnedTurn)).toHaveLength(1);
      expect(responsesForTurn(entries, firstOwnedTurn)[0]).toMatchObject({
        'gen_ai.response.model': 'gpt-5.5',
        'agent.codex.cwd': '/tmp/p',
      });
    });

    it('uses a later Stop turn only as recovery evidence and keeps earlier owned turns', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-copied-stop-recovery-'));
      tempDirs.push(root);
      const { input, entries, sessionDir, wakeupDir } = await createDormantInput(root);
      const parent = uuidV7At('2026-08-05T09:00:00.000Z', '000000000011');
      const owner = uuidV7At('2026-08-05T10:00:00.000Z', '000000000012');
      const parentTurn = uuidV7At('2026-08-05T09:30:00.000Z', '000000000013');
      const firstOwnedTurn = uuidV7At('2026-08-05T10:00:00.010Z', '000000000014');
      const latestOwnedTurn = uuidV7At('2026-08-05T10:01:00.000Z', '000000000015');
      const transcript = await writeTranscriptNamed(
        sessionDir,
        `rollout-2026-08-05T10-00-00-${owner}.jsonl`,
        [
          record('2026-08-05T10:00:00.000Z', 'session_meta', {
            id: owner, forked_from_id: parent, thread_source: 'user', model_provider: 'openai',
          }),
          ...turnBlock(parentTurn, '2026-08-05T09:30:00.000Z'),
          ...turnBlock(firstOwnedTurn, '2026-08-05T10:00:00.010Z'),
          ...turnBlock(latestOwnedTurn, '2026-08-05T10:01:00.000Z'),
        ].join('\n') + '\n',
        { bootstrapFork: false },
      );
      await writeWakeupMarker(wakeupDir, owner, {
        session_id: owner,
        turn_id: latestOwnedTurn,
        recovery_turn_id: latestOwnedTurn,
        transcript_path: transcript,
        hook_event: 'stop',
      });

      await processTranscriptOnce(input, transcript);

      expect(responsesForTurn(entries, parentTurn)).toHaveLength(0);
      expect(responsesForTurn(entries, firstOwnedTurn)).toHaveLength(1);
      expect(responsesForTurn(entries, latestOwnedTurn)).toHaveLength(1);
    });

    it('restarts a pending fork bootstrap after inode replacement without poisoning parent dedupe', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-copied-inode-pending-'));
      tempDirs.push(root);
      const { input, entries, sessionDir, stateStore } = await createDormantInput(root);
      const parent = uuidV7At('2026-08-05T09:00:00.000Z', '000000000021');
      const owner = uuidV7At('2026-08-05T10:00:00.000Z', '000000000022');
      const parentTurn = uuidV7At('2026-08-05T09:30:00.000Z', '000000000023');
      const childTurn = uuidV7At('2026-08-05T10:00:00.010Z', '000000000024');
      const transcript = await writeTranscriptNamed(
        sessionDir,
        `rollout-2026-08-05T10-00-00-${owner}.jsonl`,
        [
          record('2026-08-05T10:00:00.000Z', 'session_meta', {
            id: owner, forked_from_id: parent, thread_source: 'user', model_provider: 'openai',
          }),
          ...turnBlock(parentTurn, '2026-08-05T09:30:00.000Z'),
        ].join('\n') + '\n',
        { bootstrapFork: false },
      );

      await processTranscriptOnce(input, transcript);
      const originalStat = await fs.stat(transcript);
      expect(transcriptCheckpoint(stateStore, transcript)).toMatchObject({
        scanOffset: 0,
        forkBootstrap: { searchOffset: expect.any(Number) },
      });

      const replacement = `${transcript}.replacement`;
      await fs.writeFile(replacement, [
        record('2026-08-05T10:00:00.000Z', 'session_meta', {
          id: owner, forked_from_id: parent, thread_source: 'user', model_provider: 'openai',
        }),
        ...turnBlock(parentTurn, '2026-08-05T09:30:00.000Z'),
        ...turnBlock(childTurn, '2026-08-05T10:00:00.010Z'),
      ].join('\n') + '\n', 'utf8');
      await fs.rename(replacement, transcript);
      expect((await fs.stat(transcript)).ino).not.toBe(originalStat.ino);

      await processTranscriptOnce(input, transcript);

      expect(responsesForTurn(entries, parentTurn)).toHaveLength(0);
      expect(responsesForTurn(entries, childTurn)).toHaveLength(1);

      const parentTranscript = await writeTranscriptNamed(
        sessionDir,
        `rollout-2026-08-05T09-00-00-${parent}.jsonl`,
        [
          record('2026-08-05T09:00:00.000Z', 'session_meta', {
            id: parent, thread_source: 'user', model_provider: 'openai',
          }),
          ...turnBlock(parentTurn, '2026-08-05T09:30:00.000Z'),
        ].join('\n') + '\n',
        { bootstrapFork: false },
      );
      await processTranscriptOnce(input, parentTranscript);

      expect(responsesForTurn(entries, parentTurn)).toHaveLength(1);
    });

    it('retains fork recovery state across the anchored-before-collection inode window', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-copied-inode-anchored-'));
      tempDirs.push(root);
      const { input, entries, sessionDir, wakeupDir, stateStore } = await createDormantInput(root);
      const parent = uuidV7At('2026-08-05T09:00:00.000Z', '000000000031');
      const owner = uuidV7At('2026-08-05T10:00:00.000Z', '000000000032');
      const parentTurn = uuidV7At('2026-08-05T09:30:00.000Z', '000000000033');
      const childTurn = uuidV7At('2026-08-05T10:00:00.010Z', '000000000034');
      const text = [
        record('2026-08-05T10:00:00.000Z', 'session_meta', {
          id: owner, forked_from_id: parent, thread_source: 'user', model_provider: 'openai',
        }),
        ...turnBlock(parentTurn, '2026-08-05T09:30:00.000Z'),
        ...turnBlock(childTurn, '2026-08-05T10:00:00.010Z'),
      ].join('\n') + '\n';
      const transcript = await writeTranscriptNamed(
        sessionDir,
        `rollout-2026-08-05T10-00-00-${owner}.jsonl`,
        text,
        { bootstrapFork: false },
      );
      await writeWakeupMarker(wakeupDir, owner, {
        session_id: owner,
        initial_turn_id: childTurn,
        transcript_path: transcript,
        hook_event: 'user-prompt-submit',
      });

      await processTranscriptOnce(input, transcript);
      const anchored = transcriptCheckpoint(stateStore, transcript);
      expect(anchored.scanOffset as number).toBeGreaterThan(0);
      expect(anchored.forkBootstrap).toMatchObject({ initialTurnId: childTurn });
      expect(entries).toHaveLength(0);

      const originalStat = await fs.stat(transcript);
      const replacement = `${transcript}.replacement`;
      await fs.writeFile(replacement, text, 'utf8');
      await fs.rename(replacement, transcript);
      expect((await fs.stat(transcript)).ino).not.toBe(originalStat.ino);
      await writeWakeupMarker(wakeupDir, owner, {
        session_id: owner,
        initial_turn_id: childTurn,
        recovery_turn_id: childTurn,
        transcript_path: transcript,
        hook_event: 'stop',
      });

      await processTranscriptOnce(input, transcript);

      expect(responsesForTurn(entries, parentTurn)).toHaveLength(0);
      expect(responsesForTurn(entries, childTurn)).toHaveLength(1);
      expect(transcriptCheckpoint(stateStore, transcript).forkBootstrap).toBeUndefined();
    });

    it('baselines a consumed fork replacement without poisoning parent dedupe', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-copied-inode-consumed-'));
      tempDirs.push(root);
      const { input, entries, sessionDir, stateStore } = await createDormantInput(root);
      const parent = uuidV7At('2026-08-05T09:00:00.000Z', '000000000051');
      const owner = uuidV7At('2026-08-05T10:00:00.000Z', '000000000052');
      const parentTurn = uuidV7At('2026-08-05T09:30:00.000Z', '000000000053');
      const childTurn = uuidV7At('2026-08-05T10:00:00.010Z', '000000000054');
      const text = [
        record('2026-08-05T10:00:00.000Z', 'session_meta', {
          id: owner, forked_from_id: parent, thread_source: 'user', model_provider: 'openai',
        }),
        ...turnBlock(parentTurn, '2026-08-05T09:30:00.000Z'),
        ...turnBlock(childTurn, '2026-08-05T10:00:00.010Z'),
      ].join('\n') + '\n';
      const transcript = await writeTranscriptNamed(
        sessionDir,
        `rollout-2026-08-05T10-00-00-${owner}.jsonl`,
        text,
        { bootstrapFork: false },
      );

      await processTranscriptOnce(input, transcript);
      expect(responsesForTurn(entries, parentTurn)).toHaveLength(0);
      expect(responsesForTurn(entries, childTurn)).toHaveLength(1);
      expect(transcriptCheckpoint(stateStore, transcript)).toMatchObject({
        activeTurn: null,
        pendingTerminal: null,
      });
      expect(transcriptCheckpoint(stateStore, transcript).forkBootstrap).toBeUndefined();

      const originalStat = await fs.stat(transcript);
      const replacement = `${transcript}.replacement`;
      await fs.writeFile(replacement, text, 'utf8');
      await fs.rename(replacement, transcript);
      expect((await fs.stat(transcript)).ino).not.toBe(originalStat.ino);

      await processTranscriptOnce(input, transcript);

      expect(responsesForTurn(entries, parentTurn)).toHaveLength(0);
      expect(responsesForTurn(entries, childTurn)).toHaveLength(1);
      expect(transcriptCheckpoint(stateStore, transcript)).toMatchObject({
        activeTurn: null,
        pendingTerminal: null,
        forkBootstrap: expect.any(Object),
      });

      const parentTranscript = await writeTranscriptNamed(
        sessionDir,
        `rollout-2026-08-05T09-00-00-${parent}.jsonl`,
        [
          record('2026-08-05T09:00:00.000Z', 'session_meta', {
            id: parent, thread_source: 'user', model_provider: 'openai',
          }),
          ...turnBlock(parentTurn, '2026-08-05T09:30:00.000Z'),
        ].join('\n') + '\n',
        { bootstrapFork: false },
      );
      await processTranscriptOnce(input, parentTranscript);

      expect(responsesForTurn(entries, parentTurn)).toHaveLength(1);
    });

    it('accepts a session-matched initial anchor when transcript paths differ', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-copied-path-soft-check-'));
      tempDirs.push(root);
      const { input, entries, sessionDir, wakeupDir } = await createDormantInput(root);
      const warn = vi.fn();
      (input as unknown as { logger: { warn: typeof warn } }).logger.warn = warn;
      const owner = 'cccccccc-0004-4004-8004-000000000004';
      const currentTurn = 'owned-turn-from-soft-path-anchor';
      const transcript = await writeTranscriptNamed(
        sessionDir,
        `rollout-2026-08-05T10-00-00-${owner}.jsonl`,
        [
          record('2026-08-05T10:00:00.000Z', 'session_meta', {
            id: owner, forked_from_id: 'parent', thread_source: 'user', model_provider: 'openai',
          }),
          ...turnBlock('copied-parent-turn', '2026-08-04T10:00:00.000Z'),
          ...turnBlock(currentTurn, '2026-08-05T10:00:00.010Z'),
        ].join('\n') + '\n',
        { bootstrapFork: false },
      );
      await writeWakeupMarker(wakeupDir, owner, {
        session_id: owner,
        initial_turn_id: currentTurn,
        transcript_path: path.join(root, 'different-spelling', path.basename(transcript)),
        hook_event: 'stop',
      });

      await processTranscriptOnce(input, transcript);

      expect(responsesForTurn(entries, 'copied-parent-turn')).toHaveLength(0);
      expect(responsesForTurn(entries, currentTurn)).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('accepting session anchor'),
        expect.objectContaining({ sessionId: owner }),
      );
    });

    it('anchors at turn_context when task_started is absent', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-copied-turn-context-only-'));
      tempDirs.push(root);
      const { input, entries, sessionDir, wakeupDir } = await createDormantInput(root);
      const owner = 'cccccccc-0005-4005-8005-000000000005';
      const currentTurn = 'turn-context-only-owned-turn';
      const currentBlock = turnBlock(currentTurn, '2026-08-05T10:00:00.010Z')
        .filter(line => JSON.parse(line).payload?.type !== 'task_started');
      const transcript = await writeTranscriptNamed(
        sessionDir,
        `rollout-2026-08-05T10-00-00-${owner}.jsonl`,
        [
          record('2026-08-05T10:00:00.000Z', 'session_meta', {
            id: owner, forked_from_id: 'parent', thread_source: 'user', model_provider: 'openai',
          }),
          ...turnBlock('copied-parent-turn-with-start', '2026-08-04T10:00:00.000Z'),
          ...currentBlock,
        ].join('\n') + '\n',
        { bootstrapFork: false },
      );
      await writeWakeupMarker(wakeupDir, owner, {
        session_id: owner,
        initial_turn_id: currentTurn,
        transcript_path: transcript,
        hook_event: 'stop',
      });

      await processTranscriptOnce(input, transcript);

      expect(responsesForTurn(entries, 'copied-parent-turn-with-start')).toHaveLength(0);
      expect(responsesForTurn(entries, currentTurn)).toHaveLength(1);
      expect(responsesForTurn(entries, currentTurn)[0]).toMatchObject({
        'gen_ai.response.model': 'gpt-5.5',
        'agent.codex.cwd': '/tmp/p',
      });
    });

    it('repairs an out-of-range persisted fork search offset', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-copied-invalid-search-offset-'));
      tempDirs.push(root);
      const { input, entries, sessionDir, wakeupDir, stateStore } = await createDormantInput(root);
      const warn = vi.fn();
      (input as unknown as { logger: { warn: typeof warn } }).logger.warn = warn;
      const owner = 'cccccccc-0006-4006-8006-000000000006';
      const currentTurn = 'owned-turn-after-invalid-offset';
      const transcript = await writeTranscriptNamed(
        sessionDir,
        `rollout-2026-08-05T10-00-00-${owner}.jsonl`,
        [
          record('2026-08-05T10:00:00.000Z', 'session_meta', {
            id: owner, forked_from_id: 'parent', thread_source: 'user', model_provider: 'openai',
          }),
          ...turnBlock('copied-before-invalid-offset', '2026-08-04T10:00:00.000Z'),
          ...turnBlock(currentTurn, '2026-08-05T10:00:00.010Z'),
        ].join('\n') + '\n',
        { bootstrapFork: false },
      );
      const stat = await fs.stat(transcript);
      stateStore.update(`codex-transcript:${transcript}`, {
        lastOffset: 0,
        extra: {
          codexTranscript: {
            inode: stat.ino,
            scanOffset: 0,
            activeTurn: null,
            pendingTerminal: null,
            pendingFusion: null,
            pendingSubagent: null,
            ownerSessionMetaOffset: null,
            forkBootstrap: {
              initialTurnId: currentTurn,
              searchOffset: stat.size + 100,
            },
            emittedTerminalTurnIds: [],
          },
        },
      });
      await writeWakeupMarker(wakeupDir, owner, {
        session_id: owner,
        initial_turn_id: currentTurn,
        transcript_path: transcript,
        hook_event: 'stop',
      });

      await processTranscriptOnce(input, transcript);

      expect(responsesForTurn(entries, currentTurn)).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(
        'repaired invalid Codex fork bootstrap search offset',
        expect.objectContaining({ searchOffset: stat.size + 100, repairedSearchOffset: 0 }),
      );
    });

    it('resumes an exact-turn search when the Hook fires before task_started is appended', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-copied-hook-before-turn-'));
      tempDirs.push(root);
      const { input, entries, sessionDir, wakeupDir, stateStore } = await createDormantInput(root);
      const child = 'cccccccc-0002-4002-8002-000000000002';
      const parent = 'aaaaaaaa-0002-4002-8002-000000000002';
      const turnId = 'child-turn-late-write';
      const transcript = await writeTranscriptNamed(
        sessionDir,
        `rollout-2026-08-05T10-00-00-${child}.jsonl`,
        [
          record('2026-08-05T10:00:00.000Z', 'session_meta', {
            id: child, forked_from_id: parent, thread_source: 'user', model_provider: 'openai',
          }),
          record('2026-06-01T00:00:00.000Z', 'session_meta', { id: parent, model_provider: 'openai' }),
          ...turnBlock('parent-turn-before-hook', '2026-06-01T00:00:10.000Z'),
        ].join('\n') + '\n',
        { bootstrapFork: false },
      );
      await writeWakeupMarker(wakeupDir, child, {
        session_id: child,
        turn_id: turnId,
        initial_turn_id: turnId,
        transcript_path: transcript,
        hook_event: 'user-prompt-submit',
      });

      await processTranscriptOnce(input, transcript);
      const pending = transcriptCheckpoint(stateStore, transcript) as {
        scanOffset: number;
        forkBootstrap: { initialTurnId: string; searchOffset: number };
      };
      expect(pending.scanOffset).toBe(0);
      expect(pending.forkBootstrap.initialTurnId).toBe(turnId);
      expect(pending.forkBootstrap.searchOffset).toBeGreaterThan(0);

      await fs.appendFile(transcript, [
        record('2026-08-05T10:00:05.000Z', 'event_msg', { type: 'thread_settings_applied' }),
        record('2026-08-05T10:00:10.000Z', 'event_msg', { type: 'task_started', turn_id: turnId }),
        record('2026-08-05T10:00:11.000Z', 'turn_context', { turn_id: turnId, model: 'gpt-5.5' }),
        record('2026-08-05T10:00:12.000Z', 'response_item', {
          type: 'message', role: 'user', content: [{ type: 'input_text', text: 'new child work' }],
        }),
        record('2026-08-05T10:00:13.000Z', 'event_msg', { type: 'agent_message', message: 'done', phase: 'final' }),
        record('2026-08-05T10:00:14.000Z', 'event_msg', tokenUsage(10, 2)),
        record('2026-08-05T10:00:15.000Z', 'event_msg', { type: 'task_complete', turn_id: turnId }),
      ].join('\n') + '\n', 'utf8');

      await processTranscriptOnce(input, transcript); // establish checkpoint only
      expect(responsesForTurn(entries, turnId)).toHaveLength(0);
      await processTranscriptOnce(input, transcript); // normal poll/Stop path

      expect(responsesForTurn(entries, turnId)).toHaveLength(1);
      expect(responsesForTurn(entries, 'parent-turn-before-hook')).toHaveLength(0);
      expect(transcriptCheckpoint(stateStore, transcript).forkBootstrap).toBeUndefined();
    });

    it('uses the Hook turn rather than historical settings markers in a recursive fork', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-copied-recursive-fork-'));
      tempDirs.push(root);
      const { input, entries, sessionDir, wakeupDir } = await createDormantInput(root);
      const child = 'cccccccc-0003-4003-8003-000000000003';
      const parent = 'bbbbbbbb-0003-4003-8003-000000000003';
      const grandparent = 'aaaaaaaa-0003-4003-8003-000000000003';
      const currentTurn = 'current-fork-turn';
      const transcript = await writeTranscriptNamed(
        sessionDir,
        `rollout-2026-08-05T10-00-00-${child}.jsonl`,
        [
          record('2026-08-05T10:00:00.000Z', 'session_meta', {
            id: child, forked_from_id: parent, thread_source: 'user', model_provider: 'openai',
          }),
          record('2026-08-04T10:00:00.000Z', 'session_meta', {
            id: parent, forked_from_id: grandparent, model_provider: 'openai',
          }),
          record('2026-08-03T10:00:00.000Z', 'session_meta', { id: grandparent, model_provider: 'openai' }),
          ...turnBlock('grandparent-turn', '2026-08-03T10:00:10.000Z'),
          record('2026-08-03T10:01:00.000Z', 'event_msg', { type: 'thread_settings_applied' }),
          ...turnBlock('parent-turn-a', '2026-08-04T10:00:10.000Z'),
          record('2026-08-04T10:01:00.000Z', 'event_msg', { type: 'thread_settings_applied' }),
          ...turnBlock('parent-turn-b', '2026-08-04T10:02:10.000Z'),
          record('2026-08-05T10:00:05.000Z', 'event_msg', { type: 'thread_settings_applied' }),
          ...turnBlock(currentTurn, '2026-08-05T10:00:10.000Z'),
        ].join('\n') + '\n',
        { bootstrapFork: false },
      );
      await writeWakeupMarker(wakeupDir, child, {
        session_id: child,
        turn_id: currentTurn,
        initial_turn_id: currentTurn,
        transcript_path: transcript,
        hook_event: 'stop',
      });

      await processTranscriptOnce(input, transcript);

      expect(responsesForTurn(entries, currentTurn)).toHaveLength(1);
      expect(responsesForTurn(entries, 'grandparent-turn')).toHaveLength(0);
      expect(responsesForTurn(entries, 'parent-turn-a')).toHaveLength(0);
      expect(responsesForTurn(entries, 'parent-turn-b')).toHaveLength(0);
    });

    it('drops the copied ancestor prefix of a resume/fork rollout, keeps the child turn', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-copied-fork-'));
      tempDirs.push(root);
      const { input, entries, sessionDir } = await createInput(root);
      const child = 'cccccccc-1111-4111-8111-111111111111';
      const ancestor = 'aaaaaaaa-9999-4999-8999-999999999999';
      const text = [
        record('2026-08-05T10:00:00.000Z', 'session_meta', {
          id: child, forked_from_id: ancestor, thread_source: 'user', model_provider: 'openai',
        }),
        record('2026-06-01T00:00:00.000Z', 'session_meta', { id: ancestor, thread_source: 'user', model_provider: 'openai' }),
        ...turnBlock('ancestor-turn', '2026-06-01T00:00:10.000Z'),
        record('2026-08-05T10:00:05.000Z', 'event_msg', { type: 'thread_settings_applied', thread_settings: { model: 'gpt-5.5' } }),
        ...turnBlock('child-turn', '2026-08-05T10:00:10.000Z'),
      ].join('\n') + '\n';
      await writeTranscriptNamed(sessionDir, `rollout-2026-08-05T10-00-00-${child}.jsonl`, text);

      await waitFor(() => responsesForTurn(entries, 'child-turn').length === 1);
      await input.stop();

      expect(responsesForTurn(entries, 'child-turn')).toHaveLength(1);
      expect(responsesForTurn(entries, 'ancestor-turn')).toHaveLength(0);
      expect(entries.some(e => e['agent.codex.transcript_turn_id'] === 'ancestor-turn')).toBe(false);
    });

    it('drops the copied parent prefix of a subagent rollout, keeps the child turn', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-copied-sub-'));
      tempDirs.push(root);
      const { input, entries, sessionDir } = await createInput(root);
      const child = 'cccccccc-2222-4222-8222-222222222222';
      const parent = 'aaaaaaaa-8888-4888-8888-888888888888';
      const text = [
        record('2026-08-05T10:00:00.000Z', 'session_meta', {
          id: child, forked_from_id: parent, thread_source: 'subagent', model_provider: 'openai',
          source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_path: '/root/child' } } },
        }),
        record('2026-06-01T00:00:00.000Z', 'session_meta', { id: parent, thread_source: 'user', model_provider: 'openai' }),
        ...turnBlock('parent-turn', '2026-06-01T00:00:10.000Z'),
        record('2026-08-05T10:00:05.000Z', 'event_msg', { type: 'thread_settings_applied', thread_settings: { model: 'gpt-5.5' } }),
        ...turnBlock('subchild-turn', '2026-08-05T10:00:10.000Z'),
      ].join('\n') + '\n';
      await writeTranscriptNamed(sessionDir, `rollout-2026-08-05T10-00-00-${child}.jsonl`, text);

      await waitFor(() => responsesForTurn(entries, 'subchild-turn').length === 1);
      await input.stop();

      expect(responsesForTurn(entries, 'subchild-turn')).toHaveLength(1);
      expect(responsesForTurn(entries, 'parent-turn')).toHaveLength(0);
    });

    it('locates a Hook-anchored turn across bounded 16 MiB scan windows', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-copied-big-'));
      tempDirs.push(root);
      const { input, entries, sessionDir, wakeupDir, stateStore } = await createDormantInput(root);
      const child = 'cccccccc-4444-4444-8444-444444444444';
      const ancestor = 'aaaaaaaa-7777-4777-8777-777777777777';
      // Pad the copied region past two scan windows (32 MiB) so the boundary can
      // only be reached by resuming the probe across three cycles. Padding uses an
      // unrecognised event type so it never yields entries by itself.
      const filler = 'x'.repeat(64 * 1024);
      const padding: string[] = [];
      for (let i = 0; i < 540; i++) {
        padding.push(record('2026-06-01T00:00:20.000Z', 'event_msg', { type: 'copied_padding', filler }));
      }
      const text = [
        record('2026-08-05T10:00:00.000Z', 'session_meta', {
          id: child, forked_from_id: ancestor, thread_source: 'user', model_provider: 'openai',
        }),
        record('2026-06-01T00:00:00.000Z', 'session_meta', { id: ancestor, thread_source: 'user', model_provider: 'openai' }),
        ...turnBlock('big-ancestor-turn', '2026-06-01T00:00:10.000Z'),
        ...padding,
        record('2026-08-05T10:00:05.000Z', 'event_msg', { type: 'thread_settings_applied', thread_settings: { model: 'gpt-5.5' } }),
        ...turnBlock('big-child-turn', '2026-08-05T10:00:10.000Z'),
      ].join('\n') + '\n';
      expect(Buffer.byteLength(text)).toBeGreaterThan(32 * 1024 * 1024);
      const transcript = await writeTranscriptNamed(sessionDir, `rollout-2026-08-05T10-00-00-${child}.jsonl`, text);
      await writeWakeupMarker(wakeupDir, child, {
        session_id: child,
        initial_turn_id: 'big-child-turn',
        transcript_path: transcript,
        hook_event: 'stop',
      });

      await processTranscriptOnce(input, transcript);
      const firstOffset = ((transcriptCheckpoint(stateStore, transcript).forkBootstrap as {
        searchOffset: number;
      }).searchOffset);
      expect(firstOffset).toBeGreaterThan(0);
      expect(firstOffset).toBeLessThanOrEqual(16 * 1024 * 1024);
      expect(entries).toHaveLength(0);

      await stateStore.save();
      const restarted = await createDormantInput(root);

      await processTranscriptOnce(restarted.input, transcript);
      const secondOffset = ((transcriptCheckpoint(restarted.stateStore, transcript).forkBootstrap as {
        searchOffset: number;
      }).searchOffset);
      expect(secondOffset).toBeGreaterThan(firstOffset);
      expect(secondOffset).toBeLessThanOrEqual(32 * 1024 * 1024);
      expect(restarted.entries).toHaveLength(0);

      await processTranscriptOnce(restarted.input, transcript);

      expect(responsesForTurn(restarted.entries, 'big-child-turn')).toHaveLength(1);
      expect(responsesForTurn(restarted.entries, 'big-ancestor-turn')).toHaveLength(0);
      const checkpoint = transcriptCheckpoint(restarted.stateStore, transcript);
      expect(checkpoint.scanOffset as number).toBeGreaterThan(16 * 1024 * 1024);
      expect(checkpoint.forkBootstrap).toBeUndefined();
    }, 30_000);

    it('does not skip a normal user session that has no copied prefix', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-normal-'));
      tempDirs.push(root);
      const { input, entries, sessionDir } = await createInput(root);
      const own = 'dddddddd-3333-4333-8333-333333333333';
      const text = [
        record('2026-08-05T10:00:00.000Z', 'session_meta', { id: own, thread_source: 'user', model_provider: 'openai' }),
        ...turnBlock('normal-turn', '2026-08-05T10:00:10.000Z'),
      ].join('\n') + '\n';
      await writeTranscriptNamed(sessionDir, `rollout-2026-08-05T10-00-00-${own}.jsonl`, text);

      await waitFor(() => responsesForTurn(entries, 'normal-turn').length === 1);
      await input.stop();

      expect(responsesForTurn(entries, 'normal-turn')).toHaveLength(1);
    });
  });
});

describe('Codex transcript multimodal extraction', () => {
  type TurnBodyItem = { type: string; payload: Record<string, unknown> };

  function extractRecord(
    timestamp: string,
    type: string,
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    return { timestamp, type, payload };
  }

  function userContentItem(content: unknown[]): TurnBodyItem {
    return {
      type: 'response_item',
      payload: { type: 'message', role: 'user', content },
    };
  }

  function userMessageItem(message: string | Record<string, unknown>): TurnBodyItem {
    return {
      type: 'event_msg',
      payload: typeof message === 'string'
        ? { type: 'user_message', message }
        : { type: 'user_message', ...message },
    };
  }

  function responseItem(payload: Record<string, unknown>): TurnBodyItem {
    return { type: 'response_item', payload };
  }

  /** Shared session/turn envelope; tests only supply the varying middle body. */
  function multimodalRecords(
    body: TurnBodyItem[],
    options: {
      sessionId?: string;
      turnId?: string;
      cwd?: string;
      /** null omits agent_message (e.g. tool-only turns). */
      agentMessage?: string | null;
      lastAgentMessage?: string;
    } = {},
  ): { records: Record<string, unknown>[]; sessionId: string; turnId: string } {
    const sessionId = options.sessionId ?? 's';
    const turnId = options.turnId ?? 't';
    let seq = 0;
    const at = () => `2026-08-04T03:50:${String(seq++).padStart(2, '0')}.000Z`;
    const agentMessage = options.agentMessage === undefined ? 'ok' : options.agentMessage;
    const records: Record<string, unknown>[] = [
      extractRecord(at(), 'session_meta', { id: sessionId, model_provider: 'openai' }),
      extractRecord(at(), 'turn_context', {
        turn_id: turnId,
        model: 'gpt-5.5',
        ...(options.cwd ? { cwd: options.cwd } : {}),
      }),
      extractRecord(at(), 'event_msg', { type: 'task_started', turn_id: turnId }),
      ...body.map(item => extractRecord(at(), item.type, item.payload)),
    ];
    if (agentMessage !== null) {
      records.push(extractRecord(at(), 'event_msg', {
        type: 'agent_message', message: agentMessage, phase: 'final',
      }));
    }
    records.push(
      extractRecord(at(), 'event_msg', {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
      }),
      extractRecord(at(), 'event_msg', {
        type: 'task_complete',
        turn_id: turnId,
        last_agent_message: options.lastAgentMessage ?? agentMessage ?? 'ok',
      }),
    );
    return { records, sessionId, turnId };
  }

  function extractTurn(
    fixture: { records: Record<string, unknown>[]; sessionId: string; turnId: string },
    options?: Parameters<typeof extractCodexPartialTurn>[4],
  ) {
    return extractCodexPartialTurn(
      fixture.records,
      { sessionId: fixture.sessionId, provider: 'openai' },
      fixture.sessionId,
      fixture.turnId,
      options,
    );
  }

  function userParts(turn: NonNullable<ReturnType<typeof extractCodexPartialTurn>>): any[] {
    return (turn.inputMessages[0] as any).parts;
  }

  it('defaults allowed roots to ~/.codex', () => {
    expect(codexDefaultAllowedRootPaths()).toEqual([path.join(os.homedir(), '.codex')]);
  });

  it('write-time converts input_image to uri parts and keeps text-only prompt', () => {
    // Shape mirrors real Codex paste/upload turns (codex-hook-debug):
    // Files mentioned + path, then <image path="..."> wrapper around input_image.
    const png = Buffer.from('fake-png').toString('base64');
    const imagePath = '/tmp/pipeline.jpg';
    const userText = [
      '',
      '# Files mentioned by the user:',
      '',
      `## pipeline.jpg: ${imagePath}`,
      '',
      '## My request for Codex:',
      '这个图像是什么意思？',
      '',
    ].join('\n');
    const fixture = multimodalRecords([
      userContentItem([
        { type: 'input_text', text: userText },
        { type: 'input_text', text: `<image name=[Image #1] path="${imagePath}">` },
        { type: 'input_image', image_url: `data:image/png;base64,${png}`, detail: 'high' },
        { type: 'input_text', text: '</image>' },
      ]),
      userMessageItem({ message: userText, images: [], local_images: [imagePath] }),
    ], {
      sessionId: 'session-img',
      turnId: 'turn-img',
      cwd: '/tmp/project',
      agentMessage: 'a pipeline diagram',
    });

    const turn = extractTurn(fixture, { blobToUri: fakeBlobToUri });

    expect(turn).not.toBeNull();
    expect(turn!.prompt).toContain('这个图像是什么意思？');
    expect(turn!.prompt).toContain(imagePath);
    expect(turn!.prompt).not.toContain(png);
    expect(turn!.prompt).not.toContain('data:image');

    const parts = userParts(turn!);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: 'text', content: userText });
    expect(parts[1]).toMatchObject({
      type: 'uri',
      mime_type: 'image/png',
      modality: 'image',
    });
    expect(parts[1].uri).toMatch(/^oss:\/\/test\//);
    expect(JSON.stringify(parts)).not.toContain(png);
    expect(JSON.stringify(parts)).not.toContain('<image');
    expect(JSON.stringify(parts)).not.toContain('</image>');
    // Local path remains in the files-mentioned text; only image wrappers are collapsed.
    expect(parts[0].content).toContain(imagePath);

    const { entries } = buildCodexTranscriptSegment(turn!, { includePrompt: true });
    const request = entries.find(e => e['event.name'] === 'llm.request' || e['event.name'] === 'llm.response');
    const messages = (request?.['gen_ai.input.messages'] ?? request?.['gen_ai.input.messages_delta']) as any[];
    const outParts = messages?.[0]?.parts ?? [];
    expect(outParts.some((p: any) => p.type === 'uri')).toBe(true);
    expect(outParts.some((p: any) => p.type === 'blob')).toBe(false);
  });

  it('collapses multiple Codex image wrappers and keeps non-wrapper text', () => {
    const png1 = Buffer.from('fake-png-1').toString('base64');
    const png2 = Buffer.from('fake-png-2').toString('base64');
    const filesText = '\n# Files mentioned by the user:\n\n## a.png: /tmp/a.png\n';
    const fixture = multimodalRecords([
      userContentItem([
        { type: 'input_text', text: filesText },
        { type: 'input_text', text: '<image name=[Image #1] path="/tmp/a.png">' },
        { type: 'input_image', image_url: `data:image/png;base64,${png1}`, detail: 'high' },
        { type: 'input_text', text: '</image>' },
        { type: 'input_text', text: '<image name=[Image #2] path="/tmp/b.png">' },
        { type: 'input_image', image_url: `data:image/png;base64,${png2}`, detail: 'high' },
        { type: 'input_text', text: '</image>' },
        { type: 'input_text', text: 'compare these' },
      ]),
      userMessageItem('compare these'),
    ]);

    const turn = extractTurn(fixture, { blobToUri: fakeBlobToUri });
    expect(userParts(turn!)).toEqual([
      { type: 'text', content: filesText },
      {
        type: 'uri',
        mime_type: 'image/png',
        modality: 'image',
        uri: fakeBlobToUri({ content: png1, mime_type: 'image/png', modality: 'image' })!.uri,
      },
      {
        type: 'uri',
        mime_type: 'image/png',
        modality: 'image',
        uri: fakeBlobToUri({ content: png2, mime_type: 'image/png', modality: 'image' })!.uri,
      },
      { type: 'text', content: 'compare these' },
    ]);
  });

  it('does not collapse image tags when no uri sits between them', () => {
    const fixture = multimodalRecords([
      userContentItem([
        { type: 'input_text', text: 'look' },
        { type: 'input_text', text: '<image name=[Image #1] path="/tmp/a.png">' },
        { type: 'input_image', image_url: '/tmp/a.png' },
        { type: 'input_text', text: '</image>' },
      ]),
      userMessageItem('look'),
    ]);

    const turn = extractTurn(fixture, { blobToUri: fakeBlobToUri });
    expect(userParts(turn!)).toEqual([
      { type: 'text', content: 'look' },
      { type: 'text', content: '<image name=[Image #1] path="/tmp/a.png">' },
      { type: 'text', content: '</image>' },
    ]);
  });

  it('write-time converts function_call_output input_image arrays to uri parts', () => {
    const jpeg = Buffer.from('fake-jpeg').toString('base64');
    const fixture = multimodalRecords([
      userContentItem([{ type: 'input_text', text: '/tmp/a.jpg what is this?' }]),
      userMessageItem('/tmp/a.jpg what is this?'),
      responseItem({
        type: 'function_call', call_id: 'call-1', name: 'read_file',
        arguments: JSON.stringify({ path: '/tmp/a.jpg' }),
      }),
      responseItem({
        type: 'function_call_output',
        call_id: 'call-1',
        output: [{ type: 'input_image', image_url: `data:image/jpeg;base64,${jpeg}`, detail: 'high' }],
      }),
    ], { agentMessage: null, lastAgentMessage: 'a photo' });

    const turn = extractTurn(fixture, { blobToUri: fakeBlobToUri });
    expect(turn).not.toBeNull();
    expect(turn!.steps[0]?.tools[0]?.output).toEqual([
      {
        type: 'uri',
        mime_type: 'image/jpeg',
        modality: 'image',
        uri: fakeBlobToUri({ content: jpeg, mime_type: 'image/jpeg', modality: 'image' })!.uri,
      },
    ]);
  });

  it('gates user vs tool-result image conversion by uploadMode', () => {
    const png = Buffer.from('fake-png-mode').toString('base64');
    const fixture = multimodalRecords([
      userContentItem([
        { type: 'input_text', text: 'look' },
        { type: 'input_image', image_url: `data:image/png;base64,${png}` },
      ]),
      responseItem({
        type: 'function_call',
        call_id: 'c1',
        name: 'ReadImage',
        arguments: '{}',
      }),
      responseItem({
        type: 'function_call_output',
        call_id: 'c1',
        output: [{ type: 'input_image', image_url: `data:image/png;base64,${png}` }],
      }),
      userMessageItem('look'),
    ]);

    const off = extractTurn(fixture, { blobToUri: fakeBlobToUri, uploadMode: 'none' });
    expect(userParts(off!)).toEqual([{ type: 'text', content: 'look' }]);
    expect(JSON.stringify(off!.steps)).not.toContain('"type":"uri"');
    expect(JSON.stringify(off)).not.toContain(png);

    const inputMode = extractTurn(fixture, { blobToUri: fakeBlobToUri, uploadMode: 'input' });
    expect(userParts(inputMode!)[1]).toMatchObject({ type: 'uri' });
    const inputToolOut = inputMode!.steps.flatMap(s => s.tools).find(t => t.callId === 'c1')?.output as any[];
    expect(inputToolOut?.some(p => p.type === 'uri')).toBe(true);

    const outputMode = extractTurn(fixture, { blobToUri: fakeBlobToUri, uploadMode: 'output' });
    expect(userParts(outputMode!).some((p: any) => p.type === 'uri')).toBe(false);
    const outputToolOut = outputMode!.steps.flatMap(s => s.tools).find(t => t.callId === 'c1')?.output as any[];
    expect(outputToolOut?.some(p => p.type === 'uri')).toBe(false);
    expect(JSON.stringify(outputMode)).not.toContain(png);

    const both = extractTurn(fixture, { blobToUri: fakeBlobToUri, uploadMode: 'all' });
    expect(userParts(both!)[1]).toMatchObject({ type: 'uri' });
    const bothToolOut = both!.steps.flatMap(s => s.tools).find(t => t.callId === 'c1')?.output as any[];
    expect(bothToolOut?.some(p => p.type === 'uri')).toBe(true);
  });

  it('does not attach media when blobToUri is omitted', () => {
    const png = Buffer.from('fake-png').toString('base64');
    const fixture = multimodalRecords([
      userContentItem([
        { type: 'input_text', text: 'look' },
        { type: 'input_image', image_url: `data:image/png;base64,${png}` },
      ]),
      userMessageItem('look'),
    ]);

    const turn = extractTurn(fixture);
    expect(userParts(turn!)).toEqual([{ type: 'text', content: 'look' }]);
    expect(JSON.stringify(turn!.inputMessages)).not.toContain(png);
  });

  it('caps converted input_image parts at MAX_MULTIMODAL_PARTS', () => {
    const content = Array.from({ length: MAX_MULTIMODAL_PARTS + 2 }, (_, i) => {
      const png = Buffer.from(`img-${i}`).toString('base64');
      return { type: 'input_image', image_url: `data:image/png;base64,${png}` };
    });
    const fixture = multimodalRecords([
      userContentItem([{ type: 'input_text', text: 'many' }, ...content]),
      userMessageItem('many'),
    ]);

    const turn = extractTurn(fixture, { blobToUri: fakeBlobToUri });
    const parts = userParts(turn!);
    const uriParts = parts.filter((p: any) => p.type === 'uri');
    expect(uriParts).toHaveLength(MAX_MULTIMODAL_PARTS);
    expect(parts.some((p: any) => p.type === 'text' && p.content === 'many')).toBe(true);
  });

  // Codex currently persists images as data-URL base64; path-only input_image is not handled yet.
  it('ignores input_image with path-only image_url', () => {
    const imagePath = '/tmp/pipeline.jpg';
    const fixture = multimodalRecords([
      userContentItem([
        { type: 'input_text', text: 'look' },
        { type: 'input_image', image_url: imagePath },
      ]),
      userMessageItem('look'),
    ]);

    const turn = extractTurn(fixture, { blobToUri: fakeBlobToUri });
    expect(userParts(turn!)).toEqual([{ type: 'text', content: 'look' }]);
    expect(JSON.stringify(turn!.inputMessages)).not.toContain(imagePath);
  });

  it('passes stable reuseKey so callers can skip re-decode on partial replay', () => {
    const png = Buffer.from('fake-png-reuse').toString('base64');
    const fixture = multimodalRecords([
      userContentItem([
        { type: 'input_text', text: 'look' },
        { type: 'input_image', image_url: `data:image/png;base64,${png}` },
      ]),
      userMessageItem('look'),
    ]);

    const cache = new Map<string, ReturnType<BlobToUriFn>>();
    let decodeCount = 0;
    const cachingBlobToUri: BlobToUriFn = (params) => {
      if (params.reuseKey && cache.has(params.reuseKey)) {
        return cache.get(params.reuseKey) ?? null;
      }
      decodeCount += 1;
      const result = fakeBlobToUri(params);
      if (result && params.reuseKey) cache.set(params.reuseKey, result);
      return result;
    };

    const first = extractTurn(fixture, { blobToUri: cachingBlobToUri });
    const second = extractTurn(fixture, { blobToUri: cachingBlobToUri });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(userParts(first!)[1]).toMatchObject({ type: 'uri' });
    expect(userParts(second!)[1]).toEqual(userParts(first!)[1]);
    expect(decodeCount).toBe(1);
    expect([...cache.keys()][0]).toMatch(/^\d+:\d+$/);
  });
});

// Exercise real rollout discovery, reliable linking, recovery and event rewriting.
describe('workspace privacy during independent Codex subagent collection', () => {
  it.each([
    ['completed child, blocked parent', true, true, false],
    ['running child, blocked parent', false, true, false],
    ['completed child, public parent', true, false, false],
    ['running child, public parent', false, false, false],
    ['completed child, blocked child', true, false, true],
    ['running child, blocked child', false, false, true],
  ] as const)('%s checks privacy before attachment upload', async (_name, childTerminal, blockedParent, blockedChild) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-fusion-privacy-'));
    tempDirs.push(root);
    const sessionDir = path.join(root, 'sessions');
    const stateStore = new StateStore(path.join(root, 'state.json'));
    await stateStore.load();
    const upload = vi.fn().mockReturnValue({ uri: 'oss://test/child-image', mimeType: 'image/png', modality: 'image' });
    const input = new CodexTranscriptInput({
      stateStore, sessionDir, wakeupDir: path.join(root, 'wakeups'),
      spanContextDir: path.join(root, 'span-contexts'), pollIntervalMs: 10,
      multimodal: { enabled: true, uploadMode: 'all', processor: { blobToUri: upload } as any },
    });
    const policy = new WorkspacePolicy(['/private-project']);
    input.setWorkspacePolicy(policy);
    const parentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    if (blockedParent) {
      // A prior text-only turn has already excluded the parent session.
      expect(policy.allows({ 'gen_ai.session.id': parentId, cwd: '/private-project' }, input.agentType)).toBe(false);
    }
    const raw: AgentActivityEntry[] = [];
    const output: AgentActivityEntry[] = [];
    input.on('entries', batch => {
      raw.push(...batch);
      // InputManager applies the workspace policy after collection.
      output.push(...policy.filter(batch, input.agentType));
    });
    await input.start();
    try {
      const parentText = await fs.readFile(path.join(SUBAGENT_FIXTURE_DIR, PARENT_FIXTURE_NAME), 'utf8');
      const parentLines = parentText.trimEnd().split('\n');
      const terminal = parentLines.pop()!;
      const parentPath = await writeTranscriptNamed(sessionDir, PARENT_FIXTURE_NAME, parentLines.join('\n') + '\n');
      await waitFor(() => input.getSubagentLinkSnapshot().detectedSpawns === 4);
      const childText = await fs.readFile(path.join(SUBAGENT_FIXTURE_DIR, CHILD_FIXTURE_NAME), 'utf8');
      const childRecords = childText.trimEnd().split('\n').map(line => JSON.parse(line));
      for (const item of childRecords) {
        if (item.type === 'turn_context' && item.payload.turn_id === 'child-turn-1') {
          item.payload.cwd = blockedChild ? '/private-project' : '/public-project';
        }
        if (item.type === 'response_item' && item.payload.role === 'user'
          && item.payload.content?.some((part: any) => part.text === 'synthetic child task')) {
          item.payload.content.push({ type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' });
        }
      }
      if (!childTerminal) childRecords.pop();
      const childPath = await writeTranscriptNamed(sessionDir, CHILD_FIXTURE_NAME, childRecords.map(item => JSON.stringify(item)).join('\n') + '\n');
      await waitFor(() => {
        const checkpoint = transcriptCheckpoint(stateStore, childPath);
        return childTerminal ? checkpoint?.activeTurn === null && Boolean(checkpoint?.scanOffset)
          : Boolean(checkpoint?.activeTurn && checkpoint.scanOffset > checkpoint.activeTurn.startOffset);
      });
      if (!childTerminal) {
        expect(responsesForTurn(raw, 'child-turn-1')).toHaveLength(0);
      }
      await fs.appendFile(parentPath, terminal + '\n', 'utf8');
      await waitFor(() => transcriptCheckpoint(stateStore, parentPath)?.activeTurn === null);
      if (!childTerminal) {
        expect(responsesForTurn(raw, 'child-turn-1')).toHaveLength(0);
        await fs.appendFile(childPath, JSON.stringify(childText.trimEnd().split('\n')
          .map(line => JSON.parse(line)).at(-1)) + '\n', 'utf8');
      }
      await waitFor(() => transcriptCheckpoint(stateStore, childPath)?.activeTurn === null);
      const childEntries = raw.filter(entry => entry['agent.codex.transcript_turn_id'] === 'child-turn-1');
      if (blockedParent || blockedChild) {
        expect(upload).not.toHaveBeenCalled();
        expect(output.some(entry => entry['agent.codex.transcript_turn_id'] === 'child-turn-1')).toBe(false);
      } else {
        expect(childEntries.length).toBeGreaterThan(0);
        expect(childEntries.every(entry => entry['gen_ai.session.id'] === CHILD_FIXTURES[0].threadId
          && entry['gen_ai.agent.scope'] === 'subagent')).toBe(true);
        expect(upload).toHaveBeenCalled();
        expect(output.some(entry => entry['agent.codex.transcript_turn_id'] === 'child-turn-1')).toBe(true);
      }
    } finally { await input.stop(); }
  });
});
