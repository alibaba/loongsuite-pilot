import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { codexToolSpanId } from '../../../../src/inputs/codex-transcript/codex-transcript-builder.js';
import {
  CodexSubagentLinker,
  extractCodexSpawnDescriptors,
  isCodexWorkInput,
  MAX_LINK_DESCRIPTORS,
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

  it('preserves immediate parent linkage at arbitrary nesting depth', () => {
    const linker = new CodexSubagentLinker();
    linker.registerSpawns([spawn({ parentToolCallId: 'nested-call', childThreadId: 'nested-child' })]);
    linker.registerChild(childMeta({ threadId: 'nested-child', depth: 20 }));
    expect(linker.snapshot().links[0]).toMatchObject({
      parentThreadId: 'parent-thread', childThreadId: 'nested-child', confidence: 'explicit_id',
    });
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

  it('retains the invoke intent for a rejected spawn without inventing a child', () => {
    const turn = turnWithSpawn();
    turn.steps[0].tools[0].output = 'collab spawn failed: agent thread limit reached';

    const descriptors = extractCodexSpawnDescriptors(turn, [], 'trace-rejected');
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0].childThreadId).toBeUndefined();
    expect(descriptors[0].invocationId).toMatch(/^[0-9a-f]{32}$/);
    const linker = new CodexSubagentLinker();
    linker.registerSpawns(descriptors);
    expect(linker.resolveWork(childMeta({ threadId: 'failed-child', agentPath: '/root/activity-child' }),
      { ...turn, sessionId: 'failed-child', startedAtMs: 30 }, [], true)).toBeUndefined();
  });

  it('links an agent_id and nickname return with no activity or path', () => {
    const turn = turnWithSpawn();
    turn.steps[0].tools[0].output = { agent_id: 'child-id-only', nickname: 'Ada' };
    const linker = new CodexSubagentLinker();
    linker.registerSpawns(extractCodexSpawnDescriptors(turn, [], 'trace-id-only'));
    linker.registerChild(childMeta({ threadId: 'child-id-only' }));
    expect(linker.snapshot().links[0]).toMatchObject({
      confidence: 'explicit_id', childThreadId: 'child-id-only',
      parentToolSpanId: codexToolSpanId('parent-thread', 'parent-turn', 'call-activity'),
    });
  });

  it('reserves stable invocation and actual tool span before acceptance arrives', () => {
    const turn = turnWithSpawn();
    const pending = extractCodexSpawnDescriptors(turn, [], 'trace-pending')[0];
    turn.steps[0].tools[0].output = { agent_id: 'accepted-child' };
    const accepted = extractCodexSpawnDescriptors(turn, [], 'trace-pending')[0];
    expect(accepted.invocationId).toBe(pending.invocationId);
    expect(accepted.parentToolSpanId).toBe(pending.parentToolSpanId);
    const linker = new CodexSubagentLinker();
    linker.registerSpawns([pending, accepted]);
    expect(linker.serialize().spawns).toHaveLength(1);
    expect(linker.serialize().spawns[0].childThreadId).toBe('accepted-child');
  });

  it.each(['explicit', 'path', 'bound'])('projects the known child nickname through %s lookup and restore', kind => {
    const linker = new CodexSubagentLinker();
    linker.registerSpawns([spawn({ parentToolCallId: 'named-child', taskName: 'named',
      ...(kind === 'explicit' ? { childThreadId: 'child' } : {}),
      ...(kind === 'bound' ? { resolvedChildThreadId: 'child' } : {}),
    })]);
    linker.registerChild({ ...childMeta({ threadId: 'child', agentPath: '/root/named' }), agentNickname: 'Newton' });
    const work = linker.getDelegationsForParent('parent-thread')[0];
    expect(work).toMatchObject({ childThreadId: 'child', agentNickname: 'Newton' });
    expect(linker.serialize().spawns[0].agentNickname).toBeUndefined();
    const restored = new CodexSubagentLinker();
    restored.restore(JSON.parse(JSON.stringify(linker.serialize())));
    expect(restored.getDelegationsForParent('parent-thread')[0]).toMatchObject({
      childThreadId: 'child', agentNickname: 'Newton', invocationId: work.invocationId,
    });
  });

  it('does not guess a nickname from an ambiguous child path', () => {
    const linker = new CodexSubagentLinker();
    linker.registerSpawns([spawn({ parentToolCallId: 'ambiguous-name', taskName: 'named' })]);
    for (const [threadId, agentNickname] of [['first-child', 'Newton'], ['second-child', 'Curie']]) {
      linker.registerChild({ ...childMeta({ threadId, agentPath: '/root/named' }), agentNickname });
    }
    const work = linker.getDelegationsForParent('parent-thread')[0];
    expect(work.childThreadId).toBeUndefined();
    expect(work.agentNickname).toBeUndefined();
  });

  it('records each batch work separately while sharing its real tool span', () => {
    const turn = turnWithSpawn();
    turn.steps[0].tools[0].input = { agents: [
      { task_name: 'one', message: 'first work' },
      { task_name: 'two', message: 'second work' },
    ] };
    const pending = extractCodexSpawnDescriptors(turn, [], 'trace-batch');
    turn.steps[0].tools[0].output = { agents: [
      { agent_id: 'first-child' }, { agent_id: 'second-child' },
    ] };
    const accepted = extractCodexSpawnDescriptors(turn, [], 'trace-batch');
    expect(new Set(accepted.map(value => value.invocationId)).size).toBe(2);
    expect(new Set(accepted.map(value => value.parentToolSpanId)).size).toBe(1);
    expect(accepted.map(value => value.invocationId)).toEqual(pending.map(value => value.invocationId));
    expect(accepted.map(value => value.childThreadId)).toEqual(['first-child', 'second-child']);
  });

  it('supports task_path returns and multiple started activities in one batch', () => {
    const turn = turnWithSpawn();
    turn.steps[0].tools[0].output = { task_path: '/root/activity-child' };
    expect(extractCodexSpawnDescriptors(turn, [], 'trace-path')[0].agentPath).toBe('/root/activity-child');
    const records = ['child-a', 'child-b'].map((agent_thread_id, index) => ({
      startOffset: index, endOffset: index + 1,
      record: { type: 'event_msg', payload: {
        type: 'sub_agent_activity', kind: 'started', event_id: 'call-activity', agent_thread_id,
      } },
    }));
    expect(extractCodexSpawnDescriptors(turn, records, 'trace-path').map(value => value.childThreadId))
      .toEqual(['child-a', 'child-b']);
  });

  it('creates a new invocation for actual followup work but excludes queries and notifications', () => {
    const turn = turnWithSpawn();
    const tool = turn.steps[0].tools[0];
    tool.name = 'followup_task';
    tool.input = { target: '/root/reused', message: 'new work' };
    expect(extractCodexSpawnDescriptors(turn, [], 'trace-followup')[0]).toMatchObject({
      dispatchKind: 'followup', agentPath: '/root/reused', workFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    tool.name = 'send_input';
    tool.input = { id: 'reused', message: 'next work' };
    expect(extractCodexSpawnDescriptors(turn, [], 'trace-followup')[0]).toMatchObject({
      dispatchKind: 'input', childThreadId: 'reused',
    });
    tool.input = { id: 'reused', message: 'notice', notification_only: true };
    expect(extractCodexSpawnDescriptors(turn, [], 'trace-followup')).toEqual([]);
    tool.name = 'wait';
    expect(extractCodexSpawnDescriptors(turn, [], 'trace-followup')).toEqual([]);
    tool.name = 'send_message';
    expect(extractCodexSpawnDescriptors(turn, [], 'trace-followup')).toEqual([]);
  });

  it('binds reused child turns by received work and never by latest session delegation', () => {
    const linker = new CodexSubagentLinker();
    const first = spawn({ parentToolCallId: 'first', childThreadId: 'reused', workPrompt: 'first work', dispatchKind: 'spawn' });
    const second = spawn({ parentToolCallId: 'second', childThreadId: 'reused', workPrompt: 'second work', dispatchKind: 'followup' });
    linker.registerSpawns([first, second]);
    const meta = childMeta({ threadId: 'reused' });
    const turn = { ...turnWithSpawn(), sessionId: 'reused', startedAtMs: 30, prompt: 'first work' };
    expect(linker.resolveWork(meta, turn, [plainAgentMessage(turn.transcriptTurnId, 'first work')])).toMatchObject({ parentToolCallId: 'first' });
    expect(linker.resolveWork(meta, { ...turn, transcriptTurnId: 'second-turn', prompt: 'second work' },
      [plainAgentMessage('second-turn', 'second work')]))
      .toMatchObject({ parentToolCallId: 'second' });
    expect(linker.resolveWork(meta, { ...turn, transcriptTurnId: 'direct-turn', prompt: 'a direct user request' }, []))
      .toBeUndefined();
  });

  it('persists stable bindings and continues a logical work across turns without new input', () => {
    const linker = new CodexSubagentLinker();
    linker.registerSpawns([spawn({ parentToolCallId: 'first', childThreadId: 'child', workPrompt: 'work' })]);
    const meta = childMeta({ threadId: 'child' });
    const turn = { ...turnWithSpawn(), sessionId: 'child', startedAtMs: 30, prompt: 'work' };
    const initial = linker.resolveWork(meta, turn, [plainAgentMessage(turn.transcriptTurnId, 'work')]);
    const restored = new CodexSubagentLinker();
    restored.restore(JSON.parse(JSON.stringify(linker.serialize())));
    restored.restore(undefined);
    expect(restored.resolveWork(meta, { ...turn, prompt: undefined }, [])).toEqual(initial);
    expect(restored.resolveWork(meta, { ...turn, transcriptTurnId: 'continuation', prompt: undefined }, []))
      .toMatchObject({ invocationId: initial?.invocationId, parentToolCallId: 'first' });
    expect(restored.resolveWork(meta, { ...turn, prompt: 'new user work' }, [directUserMessage('new user work')])).toBeUndefined();
  });

  it('uses explicit child turn evidence and leaves ambiguous incoming work independent', () => {
    const linker = new CodexSubagentLinker();
    linker.registerSpawns([
      spawn({ parentToolCallId: 'first', childThreadId: 'child', workPrompt: 'same' }),
      spawn({ parentToolCallId: 'second', childThreadId: 'child', workPrompt: 'same', childTurnId: 'explicit' }),
    ]);
    const meta = childMeta({ threadId: 'child' });
    const turn = { ...turnWithSpawn(), sessionId: 'child', startedAtMs: 30, prompt: 'same' };
    expect(linker.resolveWork(meta, turn, [])).toBeUndefined();
    expect(linker.resolveWork(meta, { ...turn, transcriptTurnId: 'explicit' }, []))
      .toMatchObject({ parentToolCallId: 'second' });
  });

  it('accepts a unique confirmed creation for first work without prompt and rejects future work guesses', () => {
    const linker = new CodexSubagentLinker();
    linker.registerSpawns([spawn({ parentToolCallId: 'create', childThreadId: 'child', spawnedAtMs: 20 })]);
    const meta = childMeta({ threadId: 'child' });
    const turn = { ...turnWithSpawn(), sessionId: 'child', startedAtMs: 30 };
    expect(linker.resolveWork(meta, { ...turn, startedAtMs: 10 }, [])).toBeUndefined();
    expect(linker.resolveWork(meta, turn, [], true)).toMatchObject({ parentToolCallId: 'create' });
    expect(linker.resolveWork(meta, { ...turn, transcriptTurnId: 'later', prompt: 'unrelated work' }, [])).toBeUndefined();
  });

  it('requires a proven first-owned turn to fall back from fork-expanded input to creation lineage', () => {
    const linker = new CodexSubagentLinker();
    linker.registerSpawns([spawn({ parentToolCallId: 'create', childThreadId: 'child', workPrompt: 'original' })]);
    const meta = childMeta({ threadId: 'child' });
    const turn = { ...turnWithSpawn(), sessionId: 'child', startedAtMs: 30, prompt: 'expanded context original' };
    expect(linker.resolveWork(meta, turn, [])).toBeUndefined();
    expect(linker.resolveWork(meta, turn, [], true)).toMatchObject({ parentToolCallId: 'create' });
    expect(linker.resolveWork(meta, { ...turn, transcriptTurnId: 'direct', prompt: 'user' }, [], true)).toBeUndefined();
  });

  it('deduplicates repeated started activity rather than inventing batch work', () => {
    const turn = turnWithSpawn();
    const source = { startOffset: 0, endOffset: 1, record: { type: 'event_msg', payload: {
      type: 'sub_agent_activity', kind: 'started', event_id: 'call-activity', agent_thread_id: 'child',
    } } };
    expect(extractCodexSpawnDescriptors(turn, [source, source], 'trace')).toHaveLength(1);
  });

  it('binds opaque parent dispatch to encrypted child input without storing either payload', () => {
    const parentTurn = turnWithSpawn();
    const tool = parentTurn.steps[0].tools[0];
    tool.input = { message: 'opaque-first-work', task_name: 'beta' };
    tool.output = { agent_id: 'encrypted-child', nickname: 'Beta' };
    const first = extractCodexSpawnDescriptors(parentTurn, [], 'trace-first')[0];
    tool.callId = 'followup-encrypted';
    tool.name = 'followup_task';
    tool.input = { target: '/root/beta', message: 'opaque-followup-work' };
    const second = extractCodexSpawnDescriptors(parentTurn, [], 'trace-second')[0];
    const linker = new CodexSubagentLinker();
    linker.registerSpawns([first, second]);
    const meta = childMeta({ threadId: 'encrypted-child', agentPath: '/root/beta' });
    const turn = { ...turnWithSpawn(), sessionId: meta.threadId, transcriptTurnId: 'child-first', startedAtMs: 30,
      prompt: 'Message Type: NEW_TASK\nTask name: /root/beta' };
    expect(linker.resolveWork(meta, turn, [encryptedMessage('child-first', 'opaque-first-work')]))
      .toMatchObject({ invocationId: first.invocationId });
    const recovered = new CodexSubagentLinker();
    const serialized = JSON.stringify(linker.serialize());
    expect(serialized).not.toContain('opaque-first-work');
    expect(serialized).not.toContain('opaque-followup-work');
    expect(serialized).not.toContain('workPrompt');
    recovered.restore(JSON.parse(serialized));
    expect(recovered.resolveWork(meta, { ...turn, transcriptTurnId: 'child-second' },
      [encryptedMessage('child-second', 'opaque-followup-work')]))
      .toMatchObject({ invocationId: second.invocationId });
    expect(first.invocationId).not.toBe(second.invocationId);
  });

  it.each([false, true])('retains saved incoming work for a later opaque FINAL_ANSWER segment (restore=%s)', restore => {
    const original = new CodexSubagentLinker();
    original.registerSpawns([spawn({ parentToolCallId: 'incoming', childThreadId: 'child', workPrompt: 'opaque-incoming-work' })]);
    const meta = childMeta({ threadId: 'child', agentPath: '/root/beta' });
    const turn = { ...turnWithSpawn(), sessionId: 'child', transcriptTurnId: 'owned-turn', startedAtMs: 30,
      prompt: 'Message Type: NEW_TASK\nTask name: /root/beta' };
    const initial = original.resolveWork(meta, turn, [encryptedMessage('owned-turn', 'opaque-incoming-work')]);
    expect(initial?.invocationId).toBeDefined();
    const linker = restore ? new CodexSubagentLinker() : original;
    if (restore) linker.restore(JSON.parse(JSON.stringify(original.serialize())));
    const before = linker.serialize();
    const result = encryptedMessage('owned-turn', 'opaque-child-result', 'FINAL_ANSWER');
    expect(isCodexWorkInput(result, 'owned-turn')).toBe(false);
    expect(linker.resolveWork(meta, turn, [result])).toEqual(initial);
    expect(linker.serialize()).toBe(before);
    expect(linker.serialize().bindings).toEqual([{
      childThreadId: 'child', childTurnId: 'owned-turn', invocationId: initial!.invocationId,
    }]);
  });

  it('binds a full turn containing NEW_TASK and opaque FINAL_ANSWER without creating multiple work fingerprints', () => {
    const linker = new CodexSubagentLinker();
    linker.registerSpawns([spawn({ parentToolCallId: 'incoming', childThreadId: 'child', workPrompt: 'opaque-incoming-work' })]);
    const meta = childMeta({ threadId: 'child', agentPath: '/root/beta' });
    const turn = { ...turnWithSpawn(), sessionId: 'child', transcriptTurnId: 'owned-turn', startedAtMs: 30,
      prompt: 'Message Type: NEW_TASK\nTask name: /root/beta' };
    const work = encryptedMessage('owned-turn', 'opaque-incoming-work');
    const result = encryptedMessage('owned-turn', 'different-opaque-result', 'FINAL_ANSWER');
    expect(isCodexWorkInput(work, 'owned-turn')).toBe(true);
    expect(isCodexWorkInput(result, 'owned-turn')).toBe(false);
    expect(linker.resolveWork(meta, turn, [work, result])).toMatchObject({ parentToolCallId: 'incoming' });
    expect(linker.serialize().spawns).toHaveLength(1);
    expect(linker.serialize().bindings).toHaveLength(1);
  });

  it.each([false, true])('does not reuse a saved invocation for real NEW_TASK or direct user input (restore=%s)', restore => {
    const original = new CodexSubagentLinker();
    original.registerSpawns([
      spawn({ parentToolCallId: 'incoming', childThreadId: 'child', workPrompt: 'opaque-incoming-work' }),
      spawn({ parentToolCallId: 'followup', childThreadId: 'child', workPrompt: 'opaque-new-work', dispatchKind: 'followup' }),
    ]);
    const meta = childMeta({ threadId: 'child', agentPath: '/root/beta' });
    const turn = { ...turnWithSpawn(), sessionId: 'child', transcriptTurnId: 'owned-turn', startedAtMs: 30,
      prompt: 'Message Type: NEW_TASK\nTask name: /root/beta' };
    const initial = original.resolveWork(meta, turn, [encryptedMessage('owned-turn', 'opaque-incoming-work')]);
    const linker = restore ? new CodexSubagentLinker() : original;
    if (restore) linker.restore(JSON.parse(JSON.stringify(original.serialize())));
    expect(linker.resolveWork(meta, turn, [encryptedMessage('owned-turn', 'unobserved-new-work')])).toBeUndefined();
    expect(linker.resolveWork(meta, turn, [directUserMessage('opaque-incoming-work')])).toBeUndefined();
    const followup = linker.resolveWork(meta, turn, [encryptedMessage('owned-turn', 'opaque-new-work')]);
    expect(followup).toMatchObject({ parentToolCallId: 'followup' });
    expect(followup!.invocationId).not.toBe(initial!.invocationId);
    expect(linker.resolveWork(meta, turn, [encryptedMessage('owned-turn', 'opaque-new-result', 'FINAL_ANSWER')]))
      .toEqual(followup);
  });

  it.each([
    ['NEW_TASK envelope', 'Message Type: NEW_TASK\nTask name: /root/beta\nPayload:\nExplain this example:\nMessage Type: FINAL_ANSWER\nPayload: sample'],
    ['ordinary work text', 'Review the FINAL_ANSWER format in this example:\nMessage Type: FINAL_ANSWER\nPayload: sample'],
  ])('keeps quoted FINAL_ANSWER text inside %s as actual incoming work', (_, message) => {
    const linker = new CodexSubagentLinker();
    linker.registerSpawns([spawn({ parentToolCallId: 'quoted-header-work', childThreadId: 'child', workPrompt: message })]);
    const meta = childMeta({ threadId: 'child' });
    const turn = { ...turnWithSpawn(), sessionId: 'child', transcriptTurnId: 'quoted-header-turn', startedAtMs: 30,
      prompt: message };
    const source = plainAgentMessage('quoted-header-turn', message);
    expect(isCodexWorkInput(source, 'quoted-header-turn')).toBe(true);
    expect(linker.resolveWork(meta, turn, [source])).toMatchObject({ parentToolCallId: 'quoted-header-work' });
  });

  it('rejects multiple opaque incoming works within the same turn and scopes other turns out', () => {
    const linker = new CodexSubagentLinker();
    linker.registerSpawns([
      spawn({ parentToolCallId: 'first', childThreadId: 'child', workPrompt: 'opaque-one', childTurnId: 'mixed' }),
      spawn({ parentToolCallId: 'second', childThreadId: 'child', workPrompt: 'opaque-two' }),
    ]);
    const meta = childMeta({ threadId: 'child' });
    const turn = { ...turnWithSpawn(), sessionId: 'child', transcriptTurnId: 'mixed', startedAtMs: 30,
      prompt: 'Message Type: NEW_TASK' };
    expect(linker.resolveWork(meta, turn, [encryptedMessage('mixed', 'opaque-one'), encryptedMessage('mixed', 'opaque-two')]))
      .toBeUndefined();
    expect(linker.resolveWork(meta, turn, [encryptedMessage('mixed', 'opaque-one'), encryptedMessage('another-turn', 'opaque-two')]))
      .toMatchObject({ parentToolCallId: 'first' });
  });

  it('migrates legacy raw work prompts to fingerprints on restore', () => {
    const linker = new CodexSubagentLinker();
    linker.restore({ version: 1, spawns: [spawn({ parentToolCallId: 'legacy', childThreadId: 'child', workPrompt: 'legacy raw work' })],
      children: [], bindings: [] });
    const stored = linker.serialize().spawns[0];
    expect(stored.workPrompt).toBeUndefined();
    expect(stored.workFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(linker.serialize())).not.toContain('legacy raw work');
    const meta = childMeta({ threadId: 'child' });
    expect(linker.resolveWork(meta, { ...turnWithSpawn(), sessionId: 'child', startedAtMs: 30, prompt: 'legacy raw work' },
      [plainAgentMessage('parent-turn', 'legacy raw work')]))
      .toMatchObject({ parentToolCallId: 'legacy' });
  });

  it('does not inherit an old invocation when a direct user repeats the same delegated text', () => {
    const linker = new CodexSubagentLinker();
    linker.registerSpawns([spawn({ parentToolCallId: 'create', childThreadId: 'child', workPrompt: 'repeat' })]);
    const meta = childMeta({ threadId: 'child' });
    const turn = { ...turnWithSpawn(), sessionId: 'child', startedAtMs: 30, transcriptTurnId: 'first', prompt: 'repeat' };
    expect(linker.resolveWork(meta, turn,
      [plainAgentMessage('first', 'repeat'), directUserMessage('repeat')], true)).toBeUndefined();
    expect(linker.resolveWork(meta, turn, [directUserMessage('repeat')], true))
      .toMatchObject({ parentToolCallId: 'create' });
    const later = { ...turn, transcriptTurnId: 'direct-user' };
    expect(linker.resolveWork(meta, later, [directUserMessage('repeat')])).toBeUndefined();
    expect(linker.resolveWork(meta, later, [{ startOffset: 0, endOffset: 1, record: {
      type: 'event_msg', payload: { type: 'user_message', message: 'repeat' },
    } }])).toBeUndefined();
    expect(linker.resolveWork(meta, later, [plainAgentMessage('direct-user', 'repeat'), directUserMessage('repeat')]))
      .toBeUndefined();
    expect(linker.resolveWork(meta, { ...later, prompt: 'Message Type: NEW_TASK\nrepeat' },
      [directUserMessage('Message Type: NEW_TASK\nrepeat')])).toBeUndefined();
  });

  it.each(['# AGENTS.md instructions for /workspace', '# AGENTS.md instructions'])('keeps isolated Codex context separate from actual incoming work for %s', header => {
    const linker = new CodexSubagentLinker();
    linker.registerSpawns([spawn({ parentToolCallId: 'isolated-spawn', childThreadId: 'isolated-child', workPrompt: 'opaque-isolated-work' })]);
    const turn = { ...turnWithSpawn(), sessionId: 'isolated-child', transcriptTurnId: 'isolated-first', startedAtMs: 30 };
    const meta = childMeta({ threadId: 'isolated-child' });
    const injected = { startOffset: 0, endOffset: 10, record: { type: 'response_item', payload: {
      type: 'message', role: 'user', internal_chat_message_metadata_passthrough: { turn_id: 'isolated-first' },
      content: [
        { type: 'input_text', text: `${header}\n<INSTRUCTIONS>\nFollow local conventions.\n</INSTRUCTIONS>` },
        { type: 'input_text', text: '<environment_context>\n<cwd>/workspace</cwd>\n<shell>zsh</shell>\n</environment_context>' },
      ],
    } } };
    expect(linker.resolveWork(meta, turn, [injected, encryptedMessage('isolated-first', 'opaque-isolated-work')]))
      .toMatchObject({ parentToolCallId: 'isolated-spawn' });
    const later = { ...turn, transcriptTurnId: 'isolated-direct' };
    expect(linker.resolveWork(meta, later, [directUserMessage('opaque-isolated-work')])).toBeUndefined();
    const incomplete = structuredClone(injected);
    incomplete.record.payload.internal_chat_message_metadata_passthrough.turn_id = 'incomplete';
    incomplete.record.payload.content[0].text = `${header}\n<INSTRUCTIONS>not closed`;
    expect(linker.resolveWork(meta, { ...turn, transcriptTurnId: 'incomplete' },
      [incomplete, encryptedMessage('incomplete', 'opaque-isolated-work')])).toBeUndefined();
    const mixed = structuredClone(injected);
    mixed.record.payload.internal_chat_message_metadata_passthrough.turn_id = 'mixed';
    mixed.record.payload.content.push({ type: 'input_text', text: 'opaque-isolated-work' });
    expect(linker.resolveWork(meta, { ...turn, transcriptTurnId: 'mixed' },
      [mixed, encryptedMessage('mixed', 'opaque-isolated-work')], true)).toBeUndefined();
    expect(linker.resolveWork(meta, { ...turn, transcriptTurnId: 'unwrapped' },
      [directUserMessage('# AGENTS.md instructions for /workspace\nopaque-isolated-work'), encryptedMessage('unwrapped', 'opaque-isolated-work')]))
      .toBeUndefined();
  });

  it('does not treat a bare extracted prompt as proof of delegated work', () => {
    const linker = new CodexSubagentLinker();
    linker.registerSpawns([spawn({ parentToolCallId: 'create', childThreadId: 'child', workPrompt: 'repeat' })]);
    expect(linker.resolveWork(childMeta({ threadId: 'child' }),
      { ...turnWithSpawn(), sessionId: 'child', startedAtMs: 30, prompt: 'repeat' }, []))
      .toBeUndefined();
  });

  it('joins out-of-order batch activity by child identity without swapping logical work', () => {
    const turn = turnWithSpawn();
    turn.steps[0].tools[0].input = { agents: [{ message: 'work A' }, { message: 'work B' }] };
    turn.steps[0].tools[0].output = { agents: [{ agent_id: 'A' }, { agent_id: 'B' }] };
    const sources = ['B', 'A'].map((id, index) => ({ startOffset: index, endOffset: index + 1,
      record: { type: 'event_msg', payload: { type: 'sub_agent_activity', kind: 'started',
        event_id: 'call-activity', agent_thread_id: id, turn_id: `${id}t` } } }));
    const descriptors = extractCodexSpawnDescriptors(turn, sources, 'trace-batch');
    expect(descriptors.map(value => [value.workIndex, value.childThreadId, value.childTurnId]))
      .toEqual([[0, 'A', 'At'], [1, 'B', 'Bt']]);
    const linker = new CodexSubagentLinker();
    linker.registerSpawns(descriptors);
    expect(linker.resolveWork(childMeta({ threadId: 'A' }),
      { ...turn, sessionId: 'A', transcriptTurnId: 'At', startedAtMs: 30, prompt: 'work A' }, []))
      .toMatchObject({ invocationId: descriptors[0].invocationId });
  });

  it('leaves uncorrelated batch activities independent and rejects contradictory single-child evidence', () => {
    const turn = turnWithSpawn();
    turn.steps[0].tools[0].input = { agents: [{ message: 'work A' }, { message: 'work B' }] };
    const sources = ['B', 'A'].map((id, index) => ({ startOffset: index, endOffset: index + 1,
      record: { type: 'event_msg', payload: { type: 'sub_agent_activity', kind: 'started',
        event_id: 'call-activity', agent_thread_id: id } } }));
    expect(extractCodexSpawnDescriptors(turn, sources, 'trace-batch').map(value => value.childThreadId))
      .toEqual([undefined, undefined]);
    turn.steps[0].tools[0].input = { message: 'work A' };
    turn.steps[0].tools[0].output = { agent_id: 'A' };
    const conflicted = extractCodexSpawnDescriptors(turn, [sources[0]], 'trace-conflict');
    expect(conflicted[0].associationConflict).toBe(true);
    const linker = new CodexSubagentLinker();
    linker.registerSpawns(conflicted);
    expect(linker.resolveWork(childMeta({ threadId: 'A' }),
      { ...turn, sessionId: 'A', startedAtMs: 30 }, [], true)).toBeUndefined();
  });

  it('returns only a parent\'s delegations and enriches a unique known path without changing stored lineage', () => {
    const linker = new CodexSubagentLinker();
    linker.registerSpawns([
      spawn({ parentToolCallId: 'path-call', taskName: 'known' }),
      spawn({ parentThreadId: 'another-parent', parentToolCallId: 'other', childThreadId: 'another-child' }),
    ]);
    linker.registerChild(childMeta({ threadId: 'known-child', agentPath: '/root/known' }));
    const [descriptor] = linker.getDelegationsForParent('parent-thread');
    expect(descriptor).toMatchObject({ parentToolCallId: 'path-call', childThreadId: 'known-child' });
    descriptor.childThreadId = 'caller-mutation';
    expect(linker.getDelegationsForParent('parent-thread')[0].childThreadId).toBe('known-child');
    expect(linker.serialize().spawns.find(value => value.parentToolCallId === 'path-call')?.childThreadId).toBeUndefined();
    linker.registerChild(childMeta({ threadId: 'duplicate-path-child', agentPath: '/root/known' }));
    expect(linker.getDelegationsForParent('parent-thread')[0].childThreadId).toBeUndefined();
  });

  it('does not infer result peers for ambiguous repeated creation paths', () => {
    const linker = new CodexSubagentLinker();
    linker.registerSpawns([
      spawn({ parentToolCallId: 'one', taskName: 'same' }),
      spawn({ parentToolCallId: 'two', taskName: '/root/same' }),
    ]);
    linker.registerChild(childMeta({ threadId: 'only-observed-child', agentPath: '/root/same' }));
    expect(linker.getDelegationsForParent('parent-thread').map(value => value.childThreadId))
      .toEqual([undefined, undefined]);
  });

  it('uses child indexes for work and parent indexes for result peers without enumerating global state', () => {
    const linker = new CodexSubagentLinker();
    linker.registerSpawns([
      spawn({ parentToolCallId: 'mine', childThreadId: 'child', workPrompt: 'work' }),
      ...Array.from({ length: 50 }, (_, index) => spawn({ parentThreadId: `other-${index}`,
        parentToolCallId: `other-call-${index}`, childThreadId: `other-child-${index}` })),
    ]);
    const internals = linker as unknown as { spawns: Map<string, unknown>; bindings: Map<string, unknown> };
    const globalSpawns = vi.spyOn(internals.spawns, 'values').mockImplementation(() => { throw new Error('global spawn enumeration'); });
    const globalBindings = vi.spyOn(internals.bindings, 'values').mockImplementation(() => { throw new Error('global binding enumeration'); });
    try {
      expect(linker.getDelegationsForParent('parent-thread')).toHaveLength(1);
      expect(linker.resolveWork(childMeta({ threadId: 'child' }),
        { ...turnWithSpawn(), sessionId: 'child', startedAtMs: 30, prompt: 'work' },
        [plainAgentMessage('parent-turn', 'work')])).toMatchObject({ parentToolCallId: 'mine' });
    } finally {
      globalSpawns.mockRestore();
      globalBindings.mockRestore();
    }
  });

  it('reuses snapshot and serialization caches until actual facts change', () => {
    const linker = new CodexSubagentLinker();
    const descriptor = spawn({ parentToolCallId: 'mine', childThreadId: 'child', workPrompt: 'work' });
    const meta = childMeta({ threadId: 'child' });
    linker.registerSpawns([descriptor]);
    linker.registerChild(meta);
    const snapshot = linker.snapshot();
    const serialized = linker.serialize();
    linker.registerSpawns([{ ...descriptor }]);
    linker.registerChild({ ...meta });
    linker.restore(serialized);
    expect(linker.snapshot()).toBe(snapshot);
    expect(linker.serialize()).toBe(serialized);
    linker.registerSpawns([{ ...descriptor, childTurnId: 'new-evidence' }]);
    expect(linker.snapshot()).not.toBe(snapshot);
    expect(linker.serialize()).not.toBe(serialized);
  });

  it('maintains path, child and binding indexes across restore and evicts obsolete peers', () => {
    const linker = new CodexSubagentLinker();
    const child = childMeta({ threadId: 'owned', agentPath: '/root/restored' });
    linker.registerSpawns([spawn({ parentToolCallId: 'path', taskName: 'restored', workPrompt: 'work' })]);
    linker.registerChild(child);
    const turn = { ...turnWithSpawn(), sessionId: 'owned', startedAtMs: 30, prompt: 'work' };
    const first = linker.resolveWork(child, turn, [plainAgentMessage('parent-turn', 'work')]);
    const restored = new CodexSubagentLinker();
    restored.restore(linker.serialize());
    expect(restored.getDelegationsForParent('parent-thread')[0].childThreadId).toBe('owned');
    expect(restored.resolveWork(child, { ...turn, prompt: undefined }, [])).toEqual(first);
    restored.registerSpawns(Array.from({ length: MAX_LINK_DESCRIPTORS }, (_, index) =>
      spawn({ parentThreadId: 'filler', parentToolCallId: `fill-${index}`, childThreadId: `filler-${index}` })));
    expect(restored.getDelegationsForParent('parent-thread')).toEqual([]);
    expect(restored.resolveWork(child, turn, [plainAgentMessage('parent-turn', 'work')])).toBeUndefined();
  });

  it('keeps time-order ties ambiguous and consumes only unique preceding candidates', () => {
    const linker = new CodexSubagentLinker();
    linker.registerSpawns([
      spawn({ parentToolCallId: 'old', spawnedAtMs: 10 }),
      spawn({ parentToolCallId: 'tie-a', spawnedAtMs: 20 }),
      spawn({ parentToolCallId: 'tie-b', spawnedAtMs: 20 }),
    ]);
    linker.registerChild(childMeta({ threadId: 'earlier', createdAtMs: 15 }));
    linker.registerChild(childMeta({ threadId: 'tied', createdAtMs: 25 }));
    expect(linker.snapshot().links).toEqual([
      expect.objectContaining({ childThreadId: 'earlier', parentToolCallId: 'old', confidence: 'time_order' }),
      expect.objectContaining({ childThreadId: 'tied', confidence: 'orphan', orphanReason: 'no_candidate' }),
    ]);
  });

  it('preserves native confidence and late path ambiguity after a work binding is resolved', () => {
    const linker = new CodexSubagentLinker();
    const descriptor = spawn({ parentToolCallId: 'first', taskName: 'same', workPrompt: 'first work' });
    const meta = childMeta({ threadId: 'child', agentPath: '/root/same' });
    linker.registerSpawns([descriptor]);
    linker.registerChild(meta);
    const turn = { ...turnWithSpawn(), sessionId: 'child', startedAtMs: 30, prompt: 'first work' };
    const link = linker.resolveWork(meta, turn, [plainAgentMessage('parent-turn', 'first work')]);
    expect(link).toMatchObject({ confidence: 'agent_path' });
    expect(linker.serialize().spawns[0]).toMatchObject({ resolvedChildThreadId: 'child' });
    expect(linker.serialize().spawns[0].childThreadId).toBeUndefined();
    expect(linker.getDelegationsForParent('parent-thread')[0].childThreadId).toBe('child');
    expect(linker.snapshot().links[0]).toMatchObject({ confidence: 'agent_path' });
    linker.registerSpawns([spawn({ parentToolCallId: 'second', taskName: 'same', workPrompt: 'second work' })]);
    expect(linker.snapshot().links[0]).toMatchObject({ confidence: 'orphan', orphanReason: 'ambiguous_agent_path' });
    expect(linker.resolveWork(meta, { ...turn, prompt: undefined }, [])).toEqual(link);
  });

  it('matches a completed followup result without attributing it to an interrupted initial spawn', () => {
    const linker = new CodexSubagentLinker();
    linker.registerSpawns([
      spawn({ parentToolCallId: 'initial', childThreadId: 'child', childTurnId: 'initial-turn', dispatchKind: 'spawn' }),
      spawn({ parentToolCallId: 'followup', childThreadId: 'child', childTurnId: 'followup-turn', dispatchKind: 'followup' }),
    ]);
    const meta = childMeta({ threadId: 'child', agentPath: '/root/beta' });
    const initialTurn = { ...turnWithSpawn(), sessionId: 'child', transcriptTurnId: 'initial-turn',
      startedAtMs: 30, status: 'interrupted' as const };
    const first = linker.resolveWork(meta, initialTurn, [])!;
    linker.registerCompletedWorkResult(first, initialTurn, [{ startOffset: 0, endOffset: 1,
      record: { type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'initial-turn' } } }]);
    const followupTurn = { ...initialTurn, transcriptTurnId: 'followup-turn', status: 'completed' as const };
    const second = linker.resolveWork(meta, followupTurn, [])!;
    const delivered = 'Exact delivered result\n';
    linker.registerCompletedWorkResult(second, followupTurn, [completedMessage('followup-turn', delivered)]);
    const candidates = linker.getDelegationsForParent('parent-thread');
    const expectedFingerprint = createHash('sha256').update(delivered).digest('hex');
    expect(candidates[0].resultFingerprints).toBeUndefined();
    expect(candidates[0]).toMatchObject({ resultTerminalObserved: true, resultOutcomeKnown: true, resultChildTurnIds: ['initial-turn'] });
    expect(candidates[1].resultFingerprints).toEqual([expectedFingerprint]);
    expect(candidates[1]).toMatchObject({ resultTerminalObserved: true, resultOutcomeKnown: true, resultChildTurnIds: ['followup-turn'] });
    expect(linker.serialize().workTerminals).toEqual([
      expect.objectContaining({ invocationId: first.invocationId, terminalType: 'interrupted' }),
      expect.objectContaining({ invocationId: second.invocationId, terminalType: 'completed' }),
    ]);
    expect(candidates.filter(value => value.resultFingerprints?.includes(expectedFingerprint)))
      .toEqual([expect.objectContaining({ invocationId: second.invocationId })]);
    expect(expectedFingerprint).not.toBe(createHash('sha256').update(delivered.trim()).digest('hex'));
  });

  it('restores completed result fingerprints, preserves multiple real results and does not persist result text', () => {
    const linker = new CodexSubagentLinker();
    linker.registerSpawns([spawn({ parentToolCallId: 'work', childThreadId: 'child', childTurnId: 'first' })]);
    const meta = childMeta({ threadId: 'child' });
    const turn = { ...turnWithSpawn(), sessionId: 'child', transcriptTurnId: 'first', startedAtMs: 30 };
    const link = linker.resolveWork(meta, turn, [])!;
    const snapshot = linker.snapshot();
    const before = linker.serialize();
    linker.registerCompletedWorkResult(link, turn,
      [completedMessage('first', 'first delivered result'), completedMessage('first', '分段结果\n')]);
    expect(linker.serialize()).not.toBe(before);
    expect(linker.snapshot()).toBe(snapshot);
    const serialized = linker.serialize();
    const encoded = JSON.stringify(serialized);
    expect(encoded).not.toContain('first delivered result');
    expect(encoded).not.toContain('分段结果');
    expect(serialized.completedWorkResults).toHaveLength(2);
    expect(serialized.spawns[0].resultFingerprints).toBeUndefined();
    const restored = new CodexSubagentLinker();
    restored.restore(JSON.parse(encoded));
    const beforeReplay = restored.serialize();
    restored.registerCompletedWorkResult(link, turn, [completedMessage('first', 'first delivered result')]);
    expect(restored.serialize()).toBe(beforeReplay);
    const nextTurn = { ...turn, transcriptTurnId: 'continued' };
    restored.registerCompletedWorkResult({ ...link, childTurnId: 'continued' }, nextTurn,
      [completedMessage('continued', 'first delivered result')]);
    expect(restored.serialize().completedWorkResults).toHaveLength(3);
    const lookup = restored.getDelegationsForParent('parent-thread')[0];
    expect(lookup.resultFingerprints).toHaveLength(2);
    lookup.resultFingerprints!.push('caller mutation');
    expect(restored.getDelegationsForParent('parent-thread')[0].resultFingerprints).toHaveLength(2);
  });

  it('requires exact real completion evidence and proven matching child work before registering a result', () => {
    const linker = new CodexSubagentLinker();
    linker.registerSpawns([spawn({ parentToolCallId: 'work', childThreadId: 'child', childTurnId: 'actual' })]);
    const turn = { ...turnWithSpawn(), sessionId: 'child', transcriptTurnId: 'actual', startedAtMs: 30 };
    const link = linker.resolveWork(childMeta({ threadId: 'child' }), turn, [])!;
    linker.registerCompletedWorkResult(link, turn, [completedMessage('another-turn', 'wrong turn')]);
    linker.registerCompletedWorkResult(link, { ...turn, sessionId: 'other-child' }, [completedMessage('actual', 'wrong child')]);
    linker.registerCompletedWorkResult({ ...link, childTurnId: 'other-turn' }, turn, [completedMessage('actual', 'wrong link')]);
    linker.registerCompletedWorkResult({ ...link, confidence: 'time_order' }, turn, [completedMessage('actual', 'time guess')]);
    linker.registerCompletedWorkResult(link, turn, [{ startOffset: 0, endOffset: 1,
      record: { type: 'response_item', payload: { type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text: 'unconfirmed assistant output' }] } } }]);
    linker.registerCompletedWorkResult(link, { ...turn, status: 'interrupted' }, [completedMessage('actual', 'aborted')]);
    linker.restore({ version: 1, completedWorkResults: [{ invocationId: link.invocationId,
      childThreadId: 'child', childTurnId: 'actual', fingerprint: 'invalid or raw content' }] });
    expect(linker.serialize().completedWorkResults).toBeUndefined();
    expect(linker.getDelegationsForParent('parent-thread')[0].resultFingerprints).toBeUndefined();
  });

  it('evicts completed result facts and removes their invocation lookup entries', () => {
    const linker = new CodexSubagentLinker();
    linker.registerSpawns([spawn({ parentToolCallId: 'retained', childThreadId: 'child', invocationId: 'retained-invocation' })]);
    const fingerprint = createHash('sha256').update('synthetic result').digest('hex');
    linker.restore({ version: 1, completedWorkResults: [
      { invocationId: 'retained-invocation', childThreadId: 'child', childTurnId: 'evicted-result', fingerprint },
      ...Array.from({ length: MAX_LINK_DESCRIPTORS }, (_, index) => ({
        invocationId: `other-${index}`, childThreadId: 'another-child', childTurnId: `result-${index}`, fingerprint,
      })),
    ] });
    expect(linker.serialize().completedWorkResults).toHaveLength(MAX_LINK_DESCRIPTORS);
    expect(linker.getDelegationsForParent('parent-thread')[0].resultFingerprints).toBeUndefined();
  });

  it('enriches an agent-id-only result peer with its exact child metadata path', () => {
    const turn = turnWithSpawn();
    turn.steps[0].tools[0].input = { message: 'work', task_name: 'relative-name' };
    turn.steps[0].tools[0].output = { agent_id: 'native-child', nickname: 'Beta' };
    const linker = new CodexSubagentLinker();
    linker.registerSpawns(extractCodexSpawnDescriptors(turn, [], 'trace-native-id'));
    const meta = childMeta({ threadId: 'native-child', agentPath: '/root/child' });
    linker.registerChild(meta);
    // A duplicate path belongs to another known thread and does not weaken
    // this explicit-ID lookup or change the descriptor's original facts.
    linker.registerChild(childMeta({ threadId: 'another-child', agentPath: '/root/child' }));
    const childTurn = { ...turn, sessionId: 'native-child', transcriptTurnId: 'owned', startedAtMs: 30 };
    const link = linker.resolveWork(meta, childTurn, [plainAgentMessage('owned', 'work')])!;
    linker.registerCompletedWorkResult(link, childTurn, [completedMessage('owned', 'delivered')]);
    expect(linker.getDelegationsForParent('parent-thread')[0]).toMatchObject({
      childThreadId: 'native-child', agentPath: '/root/child',
      resultFingerprints: [createHash('sha256').update('delivered').digest('hex')],
    });
    expect(linker.serialize().spawns[0].agentPath).toBeUndefined();
  });

  it('exposes an unobserved followup terminal so a known identical result cannot establish uniqueness', () => {
    const linker = new CodexSubagentLinker();
    linker.registerSpawns([
      spawn({ parentToolCallId: 'first', childThreadId: 'child', childTurnId: 'first-turn' }),
      spawn({ parentToolCallId: 'second', childThreadId: 'child', childTurnId: 'second-turn', dispatchKind: 'followup' }),
    ]);
    const meta = childMeta({ threadId: 'child' });
    const turn = { ...turnWithSpawn(), sessionId: 'child', transcriptTurnId: 'first-turn', startedAtMs: 30 };
    const first = linker.resolveWork(meta, turn, [])!;
    linker.registerCompletedWorkResult(first, turn, [completedMessage('first-turn', 'done')]);
    const beforeSecond = linker.getDelegationsForParent('parent-thread');
    expect(beforeSecond[0]).toMatchObject({ resultTerminalObserved: true, resultChildTurnIds: ['first-turn'] });
    expect(beforeSecond[1]).toMatchObject({ resultTerminalObserved: false, resultOutcomeKnown: false, resultChildTurnIds: [] });
    expect(beforeSecond[1].resultFingerprints).toBeUndefined();
    const followup = { ...turn, transcriptTurnId: 'second-turn' };
    const second = linker.resolveWork(meta, followup, [])!;
    linker.registerCompletedWorkResult(second, followup, [completedMessage('second-turn', 'done')]);
    const fingerprint = createHash('sha256').update('done').digest('hex');
    expect(linker.getDelegationsForParent('parent-thread').filter(candidate =>
      candidate.resultFingerprints?.includes(fingerprint))).toHaveLength(2);
  });

  it('restores aborted terminals without creating result hashes and accepts legacy completed-result facts', () => {
    const linker = new CodexSubagentLinker();
    linker.registerSpawns([spawn({ parentToolCallId: 'abort', childThreadId: 'child', childTurnId: 'aborted' })]);
    const turn = { ...turnWithSpawn(), sessionId: 'child', transcriptTurnId: 'aborted', startedAtMs: 30,
      status: 'interrupted' as const };
    const link = linker.resolveWork(childMeta({ threadId: 'child' }), turn, [])!;
    const aborted: CodexTranscriptSourceRecord = { startOffset: 0, endOffset: 1, record: {
      type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'aborted', last_agent_message: 'not a delivered result' },
    } };
    linker.registerCompletedWorkResult(link, turn, [aborted]);
    const serialized = linker.serialize();
    expect(serialized.completedWorkResults).toBeUndefined();
    expect(JSON.stringify(serialized)).not.toContain('not a delivered result');
    const restored = new CodexSubagentLinker();
    restored.restore(JSON.parse(JSON.stringify(serialized)));
    expect(restored.getDelegationsForParent('parent-thread')[0]).toMatchObject({
      resultTerminalObserved: true, resultOutcomeKnown: true, resultChildTurnIds: ['aborted'],
    });
    expect(restored.getDelegationsForParent('parent-thread')[0].resultFingerprints).toBeUndefined();
    const beforeReplay = restored.serialize();
    restored.registerCompletedWorkResult(link, turn, [aborted]);
    expect(restored.serialize()).toBe(beforeReplay);
    const legacy = new CodexSubagentLinker();
    legacy.restore({ ...serialized, workTerminals: undefined, completedWorkResults: [{
      invocationId: link.invocationId, childThreadId: 'child', childTurnId: 'legacy-completed',
      fingerprint: createHash('sha256').update('legacy result').digest('hex'),
    }] });
    expect(legacy.getDelegationsForParent('parent-thread')[0]).toMatchObject({
      resultTerminalObserved: true, resultOutcomeKnown: true, resultChildTurnIds: ['legacy-completed'],
    });
  });

  it('records real completion boundaries without fabricating an absent final message', () => {
    const linker = new CodexSubagentLinker();
    linker.registerSpawns([spawn({ parentToolCallId: 'work', childThreadId: 'child', childTurnId: 'actual' })]);
    const turn = { ...turnWithSpawn(), sessionId: 'child', transcriptTurnId: 'actual', startedAtMs: 30 };
    const link = linker.resolveWork(childMeta({ threadId: 'child' }), turn, [])!;
    const snapshot = linker.snapshot();
    linker.registerCompletedWorkResult(link, turn, [{ startOffset: 0, endOffset: 1, record: {
      type: 'event_msg', payload: { type: 'task_complete', turn_id: 'actual' },
    } }]);
    expect(linker.snapshot()).toBe(snapshot);
    expect(linker.getDelegationsForParent('parent-thread')[0]).toMatchObject({
      resultTerminalObserved: true, resultOutcomeKnown: false, resultChildTurnIds: ['actual'],
    });
    expect(linker.serialize().completedWorkResults).toBeUndefined();
    expect(linker.serialize().workTerminals).toEqual([
      expect.objectContaining({ childTurnId: 'actual', terminalType: 'completed' }),
    ]);
  });

  it('evicts terminal facts and removes obsolete invocation terminal lookups', () => {
    const linker = new CodexSubagentLinker();
    linker.registerSpawns([spawn({ parentToolCallId: 'retained', invocationId: 'retained-invocation', childThreadId: 'child' })]);
    linker.restore({ version: 1, workTerminals: [
      { invocationId: 'retained-invocation', childThreadId: 'child', childTurnId: 'old', terminalType: 'interrupted' },
      ...Array.from({ length: MAX_LINK_DESCRIPTORS }, (_, index) => ({
        invocationId: `other-${index}`, childThreadId: 'another-child', childTurnId: `terminal-${index}`, terminalType: 'completed',
      })),
    ] });
    expect(linker.serialize().workTerminals).toHaveLength(MAX_LINK_DESCRIPTORS);
    expect(linker.getDelegationsForParent('parent-thread')[0]).toMatchObject({
      resultTerminalObserved: false, resultOutcomeKnown: false, resultChildTurnIds: [],
    });
  });

  it('requires result hashes for every completed turn before declaring an invocation outcome known', () => {
    const linker = new CodexSubagentLinker();
    linker.registerSpawns([spawn({ parentToolCallId: 'work', childThreadId: 'child', childTurnId: 'first' })]);
    const turn = { ...turnWithSpawn(), sessionId: 'child', transcriptTurnId: 'first', startedAtMs: 30 };
    const link = linker.resolveWork(childMeta({ threadId: 'child' }), turn, [])!;
    linker.registerCompletedWorkResult(link, turn, [completedMessage('first', 'known first result')]);
    expect(linker.getDelegationsForParent('parent-thread')[0].resultOutcomeKnown).toBe(true);
    const second = { ...turn, transcriptTurnId: 'second' };
    linker.registerCompletedWorkResult({ ...link, childTurnId: 'second' }, second, [{ startOffset: 0, endOffset: 1,
      record: { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'second' } } }]);
    expect(linker.getDelegationsForParent('parent-thread')[0]).toMatchObject({
      resultTerminalObserved: true, resultOutcomeKnown: false, resultChildTurnIds: ['first', 'second'],
    });
    const restored = new CodexSubagentLinker();
    restored.restore(JSON.parse(JSON.stringify(linker.serialize())));
    expect(restored.getDelegationsForParent('parent-thread')[0].resultOutcomeKnown).toBe(false);
    restored.registerCompletedWorkResult({ ...link, childTurnId: 'second' }, second, [completedMessage('second', 'known second result')]);
    expect(restored.getDelegationsForParent('parent-thread')[0].resultOutcomeKnown).toBe(true);
    expect(restored.serialize().spawns[0].resultOutcomeKnown).toBeUndefined();
  });
});

function completedMessage(turnId: string, message: string): CodexTranscriptSourceRecord {
  return { startOffset: 0, endOffset: 1, record: { type: 'event_msg', payload: {
    type: 'task_complete', turn_id: turnId, last_agent_message: message,
  } } };
}

function plainAgentMessage(turnId: string, text: string): CodexTranscriptSourceRecord {
  return { startOffset: 0, endOffset: 1, record: { type: 'response_item', payload: {
    type: 'agent_message', author: '/root', recipient: '/root/child',
    content: [{ type: 'input_text', text }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  } } };
}

function directUserMessage(text: string): CodexTranscriptSourceRecord {
  return { startOffset: 0, endOffset: 1, record: { type: 'response_item', payload: {
    type: 'message', role: 'user', content: [{ type: 'input_text', text }],
  } } };
}

function encryptedMessage(
  turnId: string,
  opaque: string,
  messageType: 'NEW_TASK' | 'FINAL_ANSWER' = 'NEW_TASK',
): CodexTranscriptSourceRecord {
  return { startOffset: 0, endOffset: 1, record: { type: 'response_item', payload: {
    type: 'agent_message', author: messageType === 'FINAL_ANSWER' ? '/root/beta/leaf' : '/root', recipient: '/root/beta',
    content: [
      { type: 'input_text', text: `Message Type: ${messageType}\nTask name: /root/beta` },
      { type: 'encrypted_content', encrypted_content: opaque },
    ],
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  } } };
}

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
