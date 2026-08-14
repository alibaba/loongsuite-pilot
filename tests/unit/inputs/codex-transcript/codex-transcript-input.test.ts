import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_RESOURCE_ENV_FIELD_MAP } from '../../../../assets/hooks/shared/resource-context.mjs';
import { StateStore } from '../../../../src/checkpoints/state-store.js';
import { extractCodexTranscriptMeta } from '../../../../src/inputs/codex-transcript/codex-transcript-extractor.js';
import { CodexTranscriptInput } from '../../../../src/inputs/codex-transcript/codex-transcript-input.js';
import type { AgentActivityEntry, JsonValue } from '../../../../src/types/index.js';

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

async function finalizeSubagentFusions(input: CodexTranscriptInput): Promise<number> {
  return (input as unknown as { finalizeReadySubagentFusions(): Promise<number> })
    .finalizeReadySubagentFusions();
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

  it('holds the parent terminal and fuses completed child rollouts into the parent turn', async () => {
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
    await waitFor(() => [...childTranscripts.values()].every(transcript =>
      Boolean(transcriptCheckpoint(stateStore, transcript)?.pendingSubagent)));
    expect(globalProcessedTurnIds(stateStore)).not.toContain('parent-turn-1');
    expect(CHILD_FIXTURES.every(fixture => responsesForTurn(entries, fixture.turnId).length === 0)).toBe(true);

    await fs.appendFile(parentTranscript, parentTerminal + '\n', 'utf8');
    await waitFor(() => CHILD_FIXTURES.every(fixture =>
      responsesForTurn(entries, fixture.turnId).length === 1));
    await input.stop();

    expect(responsesForTurn(entries, 'parent-turn-1')).toHaveLength(2);
    for (const fixture of CHILD_FIXTURES) {
      const childEntries = entries.filter(entry =>
        entry['agent.codex.transcript_turn_id'] === fixture.turnId);
      expect(childEntries.length).toBeGreaterThan(0);
      expect(new Set(childEntries.map(entry => entry['gen_ai.session.id']))).toEqual(
        new Set(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']),
      );
      expect(new Set(childEntries.map(entry => entry['gen_ai.agent.id']))).toEqual(
        new Set([fixture.threadId]),
      );
      expect(new Set(childEntries.map(entry => entry['gen_ai.turn.id']))).toEqual(
        new Set(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:parent-turn-1']),
      );
      expect(transcriptCheckpoint(stateStore, childTranscripts.get(fixture.threadId)!)).toMatchObject({
        ownerSessionMetaOffset: 0,
      });
      expect(childEntries.every(entry => entry['gen_ai.agent.scope'] === 'subagent')).toBe(true);
      expect(childEntries.every(entry => entry['gen_ai.agent.depth'] === 1)).toBe(true);
      expect(new Set(childEntries.map(entry => entry['gen_ai.subagent.parent_tool_call.id']))).toEqual(
        new Set([`call-subagent-${CHILD_FIXTURES.indexOf(fixture) + 1}`]),
      );
      expect(childEntries.some(entry => entry['event.name'] === 'other')).toBe(false);
      expect(childEntries.find(entry => entry['event.name'] === 'llm.request')).toEqual(
        expect.objectContaining({
          'gen_ai.input.messages': expect.any(Array),
        }),
      );
    }
    expect(globalProcessedTurnIds(stateStore)).toEqual(expect.arrayContaining([
      'parent-turn-1',
      ...CHILD_FIXTURES.map(fixture => fixture.turnId),
    ]));
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

  it('captures child terminals before the parent terminal and keeps scanning later child turns', async () => {
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
    await waitFor(() => childTranscripts.every(transcript =>
      Boolean(transcriptCheckpoint(stateStore, transcript)?.pendingSubagent)));
    for (const [index, transcript] of childTranscripts.entries()) {
      const childStat = await fs.stat(transcript);
      expect(transcriptCheckpoint(stateStore, transcript)).toMatchObject({
        scanOffset: childStat.size,
        pendingSubagent: {
          parentTurnId: 'parent-turn-1',
          parentToolCallId: `call-subagent-${index + 1}`,
          confidence: 'agent_path',
          activeTurn: { turnId: CHILD_FIXTURES[index]!.turnId },
        },
        activeTurn: null,
      });
    }
    expect(CHILD_FIXTURES.every(fixture => responsesForTurn(entries, fixture.turnId).length === 0)).toBe(true);

    const followupLines = simpleCompletedTurn(
      CHILD_FIXTURES[0].threadId,
      'child-followup-turn',
      'follow up after the captured child terminal',
      'followup complete',
      10,
      2,
      '2026-08-07T02:02:00.000Z',
    ).slice(1);
    await fs.appendFile(childTranscripts[0]!, followupLines.join('\n') + '\n', 'utf8');
    await waitFor(() => responsesForTurn(entries, 'child-followup-turn').length === 1);
    expect(transcriptCheckpoint(stateStore, childTranscripts[0]!).pendingSubagent).not.toBeNull();

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

  it('forces a reliably linked active child to finalize when the parent reaches task_complete', async () => {
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
    expect(transcriptCheckpoint(stateStore, parentTranscript).pendingFusion).not.toBeNull();

    await finalizeSubagentFusions(input);

    expect(responsesForTurn(entries, 'child-turn-1')).toHaveLength(1);
    expect(responsesForTurn(entries, 'child-turn-1')[0]).toMatchObject({
      'gen_ai.agent.scope': 'subagent',
      'gen_ai.subagent.parent_tool_call.id': 'call-subagent-1',
      'agent.codex.turn_status': 'interrupted',
    });
    expect(responsesForTurn(entries, 'parent-turn-1')).toHaveLength(2);
    expect(transcriptCheckpoint(stateStore, childTranscript)).toMatchObject({
      activeTurn: null,
      pendingSubagent: null,
      emittedTerminalTurnIds: ['child-turn-1'],
    });
    expect(transcriptCheckpoint(stateStore, parentTranscript)).toMatchObject({
      activeTurn: null,
      pendingFusion: null,
    });
  });

  it('releases the parent when a reliable child cannot be rebuilt and emits that child independently later', async () => {
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
    expect(transcriptCheckpoint(stateStore, parentTranscript).pendingFusion).not.toBeNull();

    await finalizeSubagentFusions(input);

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
    expect(responsesForTurn(entries, 'child-turn-1')[0]).not.toHaveProperty('gen_ai.agent.scope', 'subagent');
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

  it('does not treat followup_task as a new child lifecycle that requires fusion', async () => {
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

  it('releases a captured agent_path candidate if a later spawn makes the path ambiguous', async () => {
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
      pendingSubagent: {
        parentToolCallId: 'call-subagent-1',
        confidence: 'agent_path',
      },
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
      pendingSubagent: {
        parentToolCallId: 'call-subagent-1',
        confidence: 'explicit_id',
      },
    });
    expect(transcriptCheckpoint(stateStore, childTranscripts[1]!)).toMatchObject({
      pendingSubagent: {
        parentToolCallId: 'call-subagent-2',
        confidence: 'explicit_id',
      },
    });

    await fs.appendFile(parentTranscript, parentTerminal + '\n', 'utf8');
    await processTranscriptOnce(input, parentTranscript);
    expect((transcriptCheckpoint(stateStore, parentTranscript).pendingFusion as { children: unknown[] }).children)
      .toHaveLength(2);
    await finalizeSubagentFusions(input);

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

  it('recovers a persisted parent fusion when child rollouts appear before restart', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-subagent-restart-'));
    tempDirs.push(root);
    const first = await createInput(root);
    const parentFixture = await fs.readFile(path.join(SUBAGENT_FIXTURE_DIR, PARENT_FIXTURE_NAME), 'utf8');
    const parentLines = parentFixture.trimEnd().split('\n');
    const parentTerminal = parentLines.pop()!;
    const parentTranscript = await writeTranscriptNamed(
      first.sessionDir,
      PARENT_FIXTURE_NAME,
      parentLines.join('\n') + '\n',
    );
    await waitFor(() => first.input.getSubagentLinkSnapshot().detectedSpawns === 4);
    for (const fixture of CHILD_FIXTURES) {
      const text = await fs.readFile(path.join(SUBAGENT_FIXTURE_DIR, fixture.name), 'utf8');
      await writeTranscriptNamed(first.sessionDir, fixture.name, text);
    }
    await waitFor(() => CHILD_FIXTURES.every(fixture => {
      const transcript = path.join(first.sessionDir, '2026', '06', '24', fixture.name);
      return Boolean(transcriptCheckpoint(first.stateStore, transcript)?.pendingSubagent);
    }));
    await first.input.stop();
    await first.stateStore.save();
    await fs.appendFile(parentTranscript, parentTerminal + '\n', 'utf8');

    const restarted = await createInput(root);
    await waitFor(() => CHILD_FIXTURES.every(fixture =>
      responsesForTurn(restarted.entries, fixture.turnId).length === 1));
    await restarted.input.stop();

    expect(transcriptCheckpoint(restarted.stateStore, parentTranscript)).toMatchObject({
      pendingFusion: null,
      activeTurn: null,
    });
    expect(restarted.entries.filter(entry => entry['gen_ai.agent.scope'] === 'subagent').length)
      .toBeGreaterThan(0);
    expect(restarted.entries.every(entry => entry['gen_ai.session.id'] === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'))
      .toBe(true);
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

  it('uses exact parent turn ownership when child metadata has no creation timestamp', async () => {
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
      emittedTerminalTurnIds?: string[];
    };
    expect(checkpoint.activeTurn).toBeNull();
    expect(checkpoint.pendingTerminal).toBeNull();
    expect(checkpoint.emittedTerminalTurnIds).toEqual([forkTurnId]);
    expect(globalProcessedTurnIds(stateStore)).not.toContain(controlTurnId);

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
    }).emittedTerminalTurnIds).toEqual([restartedTurnId]);
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
      'agent.codex.turn_status': 'completed',
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
      expect(globalProcessedTurnIds(stateStore)).not.toContain(parentTurn);
      expect(globalProcessedTurnIds(stateStore)).toContain(childTurn);

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
