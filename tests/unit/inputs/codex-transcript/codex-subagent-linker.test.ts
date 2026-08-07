import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CodexSubagentLinker,
  extractCodexSpawnDescriptors,
  type CodexSpawnDescriptor,
} from '../../../../src/inputs/codex-transcript/codex-subagent-linker.js';
import {
  extractCodexPartialTurn,
  extractCodexTranscriptMeta,
} from '../../../../src/inputs/codex-transcript/codex-transcript-extractor.js';
import type {
  CodexExtractedTranscriptTurn,
  CodexTranscriptMeta,
  CodexTranscriptSourceRecord,
} from '../../../../src/inputs/codex-transcript/codex-transcript-types.js';

const FIXTURE_DIR = path.resolve(process.cwd(), 'tests/fixtures/codex-subagent');
const PARENT_FIXTURE = 'rollout-2026-08-07T10-00-00-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl';
const CHILD_FIXTURES = [
  'rollout-2026-08-07T10-00-04-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl',
  'rollout-2026-08-07T10-00-05-cccccccc-cccc-4ccc-8ccc-cccccccccccc.jsonl',
  'rollout-2026-08-07T10-00-06-dddddddd-dddd-4ddd-8ddd-dddddddddddd.jsonl',
  'rollout-2026-08-07T10-00-07-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.jsonl',
] as const;

describe('CodexSubagentLinker', () => {
  it('extracts the parent delegation agent_message as the child prompt', () => {
    const turnId = 'child-turn-agent-message';
    const meta = childMeta({
      threadId: 'child-agent-message',
      agentPath: '/root/child_agent_message',
    });
    const records = [
      {
        timestamp: '2026-08-07T09:20:31.534Z',
        type: 'turn_context',
        payload: { turn_id: turnId, model: 'gpt-5.4' },
      },
      {
        timestamp: '2026-08-07T09:20:31.538Z',
        type: 'response_item',
        payload: {
          type: 'agent_message',
          author: '/root',
          recipient: '/root/child_agent_message',
          content: [
            { type: 'input_text', text: 'inspect the delegated file' },
            { type: 'encrypted_content', encrypted_content: 'redacted' },
          ],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
      },
      {
        timestamp: '2026-08-07T09:20:42.113Z',
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'response-child',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'done' }],
        },
      },
      {
        timestamp: '2026-08-07T09:20:42.255Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } },
        },
      },
      {
        timestamp: '2026-08-07T09:20:42.270Z',
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: turnId, last_agent_message: 'done' },
      },
    ];

    const turn = extractCodexPartialTurn(records, meta, meta.threadId, turnId);

    expect(turn).toMatchObject({
      prompt: 'inspect the delegated file',
      promptReady: true,
      inputMessages: [{
        role: 'user',
        parts: [{ type: 'text', content: 'inspect the delegated file' }],
      }],
    });
  });

  it('links all four fixture children by agent path even when children arrive first', async () => {
    const linker = new CodexSubagentLinker();
    for (const fixture of CHILD_FIXTURES) {
      linker.registerChild(await readOwnerMeta(fixture));
    }

    expect(linker.snapshot()).toMatchObject({
      detectedChildren: 4,
      detectedSpawns: 0,
      linkedChildren: 0,
      orphanChildren: 4,
    });

    const { turn, sources } = await readParentTurn();
    linker.registerSpawns(extractCodexSpawnDescriptors(turn, sources, 'parent-trace-id'));

    const snapshot = linker.snapshot();
    expect(snapshot).toMatchObject({
      detectedChildren: 4,
      detectedSpawns: 4,
      linkedChildren: 4,
      orphanChildren: 0,
    });
    expect(snapshot.links.map(link => ({
      childThreadId: link.childThreadId,
      parentToolCallId: link.parentToolCallId,
      confidence: link.confidence,
    }))).toEqual([
      { childThreadId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', parentToolCallId: 'call-subagent-1', confidence: 'agent_path' },
      { childThreadId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', parentToolCallId: 'call-subagent-2', confidence: 'agent_path' },
      { childThreadId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', parentToolCallId: 'call-subagent-3', confidence: 'agent_path' },
      { childThreadId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', parentToolCallId: 'call-subagent-4', confidence: 'agent_path' },
    ]);
  });

  it('prefers an explicit child thread id over a mismatched path', () => {
    const linker = new CodexSubagentLinker();
    linker.registerSpawns([
      spawn({
        parentToolCallId: 'call-explicit',
        taskName: '/root/not-the-child-path',
        childThreadId: 'child-explicit',
      }),
    ]);
    linker.registerChild(childMeta({
      threadId: 'child-explicit',
      agentPath: '/root/actual-child-path',
    }));

    expect(linker.snapshot().links).toEqual([
      expect.objectContaining({
        childThreadId: 'child-explicit',
        parentToolCallId: 'call-explicit',
        confidence: 'explicit_id',
      }),
    ]);
  });

  it('pairs unmatched children with the nearest preceding unclaimed spawn', () => {
    const linker = new CodexSubagentLinker();
    linker.registerSpawns([
      spawn({ parentToolCallId: 'call-1', spawnedAtMs: 10 }),
      spawn({ parentToolCallId: 'call-2', spawnedAtMs: 20 }),
    ]);
    linker.registerChild(childMeta({ threadId: 'child-1', createdAtMs: 15, agentPath: undefined }));
    linker.registerChild(childMeta({ threadId: 'child-2', createdAtMs: 25, agentPath: undefined }));

    expect(linker.snapshot().links.map(link => [link.childThreadId, link.parentToolCallId, link.confidence])).toEqual([
      ['child-1', 'call-1', 'time_order'],
      ['child-2', 'call-2', 'time_order'],
    ]);
  });

  it('reserves exact path matches before assigning time-order fallbacks', () => {
    const linker = new CodexSubagentLinker();
    linker.registerSpawns([
      spawn({ parentToolCallId: 'call-fallback', spawnedAtMs: 10 }),
      spawn({ parentToolCallId: 'call-exact', spawnedAtMs: 20, taskName: '/root/exact' }),
    ]);
    linker.registerChild(childMeta({ threadId: 'child-without-path', createdAtMs: 25, agentPath: undefined }));
    linker.registerChild(childMeta({ threadId: 'child-exact', createdAtMs: 30, agentPath: '/root/exact' }));

    expect(linker.snapshot().links.map(link => [link.childThreadId, link.parentToolCallId, link.confidence])).toEqual([
      ['child-without-path', 'call-fallback', 'time_order'],
      ['child-exact', 'call-exact', 'agent_path'],
    ]);
  });

  it('leaves duplicate exact paths orphaned instead of guessing by time', () => {
    const linker = new CodexSubagentLinker();
    linker.registerSpawns([
      spawn({ parentToolCallId: 'call-1', spawnedAtMs: 10, taskName: '/root/reused' }),
      spawn({ parentToolCallId: 'call-2', spawnedAtMs: 20, taskName: '/root/reused' }),
    ]);
    linker.registerChild(childMeta({
      threadId: 'child-ambiguous',
      createdAtMs: 30,
      agentPath: '/root/reused',
    }));

    expect(linker.snapshot().links).toEqual([
      expect.objectContaining({
        childThreadId: 'child-ambiguous',
        confidence: 'orphan',
        orphanReason: 'ambiguous_agent_path',
      }),
    ]);
  });

  it('ignores nested children because phase 2 is depth-one only', () => {
    const linker = new CodexSubagentLinker();
    linker.registerChild(childMeta({ threadId: 'nested-child', depth: 2 }));
    expect(linker.snapshot().detectedChildren).toBe(0);
  });

  it('extracts explicit child facts from sub_agent_activity records', () => {
    const turn = turnWithSpawn();
    const sources: CodexTranscriptSourceRecord[] = [{
      startOffset: 0,
      endOffset: 1,
      record: {
        type: 'event_msg',
        payload: {
          type: 'sub_agent_activity',
          kind: 'started',
          event_id: 'call-activity',
          occurred_at_ms: 1234,
          agent_thread_id: 'child-from-activity',
          agent_path: '/root/activity-child',
        },
      },
    }];

    expect(extractCodexSpawnDescriptors(turn, sources, 'trace-activity')).toEqual([
      expect.objectContaining({
        parentThreadId: 'parent-thread',
        parentTurnId: 'parent-turn',
        parentTraceId: 'trace-activity',
        parentToolCallId: 'call-activity',
        childThreadId: 'child-from-activity',
        agentPath: '/root/activity-child',
        spawnedAtMs: 1234,
      }),
    ]);
  });

  it('does not create a descriptor for a rejected spawn call', () => {
    const turn = turnWithSpawn();
    turn.steps[0].tools[0].output = 'collab spawn failed: agent thread limit reached';

    expect(extractCodexSpawnDescriptors(turn, [], 'trace-rejected')).toEqual([]);
  });
});

async function readOwnerMeta(fixture: string): Promise<CodexTranscriptMeta> {
  const records = await readFixture(fixture);
  const meta = extractCodexTranscriptMeta(records[0]);
  if (!meta) throw new Error(`missing owner meta in ${fixture}`);
  return meta;
}

async function readParentTurn(): Promise<{
  turn: CodexExtractedTranscriptTurn;
  sources: CodexTranscriptSourceRecord[];
}> {
  const records = await readFixture(PARENT_FIXTURE);
  const meta = extractCodexTranscriptMeta(records[0]);
  const turn = extractCodexPartialTurn(
    records,
    meta,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'parent-turn-1',
  );
  if (!turn) throw new Error('parent fixture turn was not extracted');
  return {
    turn,
    sources: records.map((record, index) => ({ startOffset: index, endOffset: index + 1, record })),
  };
}

async function readFixture(fixture: string): Promise<Record<string, unknown>[]> {
  return (await fs.readFile(path.join(FIXTURE_DIR, fixture), 'utf8'))
    .trimEnd()
    .split('\n')
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

function childMeta(overrides: {
  threadId: string;
  createdAtMs?: number;
  agentPath?: string;
  depth?: number;
}): CodexTranscriptMeta {
  return {
    threadId: overrides.threadId,
    rootSessionId: 'root-session',
    threadSource: 'subagent',
    parentThreadId: 'parent-thread',
    depth: overrides.depth ?? 1,
    createdAtMs: overrides.createdAtMs ?? 30,
    ...(overrides.agentPath ? { agentPath: overrides.agentPath } : {}),
    provider: 'openai',
  };
}

function spawn(overrides: Partial<CodexSpawnDescriptor> & Pick<CodexSpawnDescriptor, 'parentToolCallId'>): CodexSpawnDescriptor {
  return {
    parentThreadId: 'parent-thread',
    parentTurnId: 'parent-turn',
    parentTraceId: 'parent-trace',
    spawnedAtMs: 10,
    ...overrides,
  };
}

function turnWithSpawn(): CodexExtractedTranscriptTurn {
  return {
    sessionId: 'parent-thread',
    transcriptTurnId: 'parent-turn',
    provider: 'openai',
    model: 'gpt-test',
    status: 'completed',
    startedAtMs: 1,
    terminalAtMs: 2,
    promptReady: true,
    inputMessages: [],
    steps: [{
      startedAtMs: 1,
      responseAtMs: 2,
      hasResponseEvidence: true,
      completedAtMs: 2,
      reasoning: [],
      tools: [{
        callId: 'call-activity',
        name: 'spawn_agent',
        input: { task_name: 'activity-child' },
        startedAtMs: 1,
      }],
    }],
    unmatchedTokenUsages: [],
  };
}
