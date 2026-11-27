import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { StateStore } from '../../../src/checkpoints/state-store.js';
import { __testing, CodeBuddyRolloutInput } from '../../../src/inputs/codebuddy/codebuddy-rollout-input.js';

const { parseRolloutConversation } = __testing;

function userLine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'u1',
    timestamp: 1_733_000_000_000,
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: '只回复两个字：成功' }],
    providerData: { agent: 'cli', conversationRequestId: 'req-1' },
    sessionId: 'sess-1',
    _meta: {
      traceparent: '00-9d1ca988b89868a4dcb007bdee4adf24-ae6eddfece965065-01',
      baggage: 'codebuddy.session_id=sess-1,codebuddy.conversation_request_id=req-1',
    },
    ...overrides,
  };
}

function assistantLine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'a1',
    timestamp: 1_733_000_000_500,
    type: 'message',
    role: 'assistant',
    content: [{ providerData: { annotations: [] }, type: 'output_text', text: '成功' }],
    providerData: {
      conversationRequestId: 'req-1',
      messageId: 'mid-1',
      stepSeq: 1,
      model: 'moma_deepseek-v4.1-flash',
      requestModelId: 'custom-local:moma_deepseek-v4.1-flash',
      requestModelName: 'moma_deepseek-v4.1-flash',
      traceId: '9d1ca988b89868a4dcb007bdee4adf24',
      usage: { requests: 1, inputTokens: 18897, outputTokens: 2, totalTokens: 18899, inputTokensDetails: [{ cached_tokens: 18816 }] },
    },
    sessionId: 'sess-1',
    _meta: {
      traceparent: '00-9d1ca988b89868a4dcb007bdee4adf24-ae6eddfece965065-01',
      baggage: 'codebuddy.session_id=sess-1,codebuddy.conversation_request_id=req-1',
    },
    ...overrides,
  };
}

function toJsonl(lines: Array<Record<string, unknown>>): string {
  return lines.map(line => JSON.stringify(line)).join('\n') + '\n';
}

describe('parseRolloutConversation', () => {
  it('maps a single-turn rollout into the history conversation shape', () => {
    const conv = parseRolloutConversation(toJsonl([
      { type: 'session-meta', sessionId: 'sess-1', timestamp: 1 },
      userLine(),
      { type: 'file-history-snapshot', timestamp: 2 },
      { type: 'ai-title', aiTitle: 'Reply with two characters', timestamp: 3 },
      assistantLine(),
    ]), 'sess-1');

    expect(conv).not.toBeNull();
    expect(conv!.conversationId).toBe('sess-1');
    expect(conv!.index.requests).toHaveLength(1);
    const request = conv!.index.requests![0];
    expect(request.id).toBe('req-1');
    expect(request.state).toBe('complete');
    expect(request.startedAt).toBe(1_733_000_000_000);
    expect(request.usage).toEqual({
      inputTokens: 18897, outputTokens: 2, totalTokens: 18899, cacheTokens: 18816,
    });
    expect(conv!.messages).toHaveLength(2);
    const [user, assistant] = conv!.messages;
    expect(user.role).toBe('user');
    expect(JSON.parse(user.message)).toEqual({
      role: 'user',
      content: [{ type: 'text', text: '只回复两个字：成功' }],
    });
    expect(assistant.role).toBe('assistant');
    const extra = JSON.parse(assistant.extra!);
    expect(extra.traceId).toBe('9d1ca988b89868a4dcb007bdee4adf24');
    expect(extra.responseId).toBe('mid-1');
    expect(extra.modelName).toBe('moma_deepseek-v4.1-flash');
  });

  it('parses the OpenAI-style providerData.rawUsage the CLI persists (no normalized usage)', () => {
    // Real CLI shape: assistant line carries rawUsage (snake_case) and no
    // `usage` field; cached/miss/credit breakdowns ride along.
    const conv = parseRolloutConversation(toJsonl([
      userLine(),
      assistantLine({
        providerData: {
          conversationRequestId: 'req-1',
          messageId: 'mid-1',
          stepSeq: 2,
          agent: 'cli',
          model: 'hy4-flash-free',
          requestModelId: 'hy4flash-free',
          requestModelName: 'Hy4 flash',
          traceId: 'e770cc28b3c4333d1b259d5dd4b2f2e3',
          rawUsage: {
            prompt_tokens: 39654,
            completion_tokens: 265,
            total_tokens: 39919,
            prompt_tokens_details: { cached_tokens: 25984 },
            prompt_cache_hit_tokens: 25984,
            prompt_cache_miss_tokens: 13670,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            completion_tokens_details: { reasoning_tokens: 49 },
            credit: 0,
          },
        },
      }),
    ]), 'sess-1');

    expect(conv).not.toBeNull();
    const request = conv!.index.requests![0];
    expect(request.usage).toEqual({
      inputTokens: 39654,
      outputTokens: 265,
      totalTokens: 39919,
      cacheTokens: 25984,
      cachedWriteTokens: 0,
      cachedMissTokens: 13670,
      credit: 0,
    });
    const extra = JSON.parse(conv!.messages[1].extra!);
    expect(extra.traceId).toBe('e770cc28b3c4333d1b259d5dd4b2f2e3');
  });

  it('groups lines into one request per conversationRequestId with per-turn traces', () => {
    const conv = parseRolloutConversation(toJsonl([
      // Every line of a turn carries the same per-turn traceparent (the CLI
      // keeps a per-turn trace carrier).
      userLine({
        id: 'u1', timestamp: 1_000,
        _meta: {
          traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
          baggage: 'codebuddy.session_id=sess-1,codebuddy.conversation_request_id=req-1',
        },
      }),
      assistantLine({
        id: 'a1', timestamp: 2_000,
        content: [{ type: 'output_text', text: '你好' }],
        _meta: { traceparent: '00-11111111111111111111111111111111-2222222222222222-01' },
        providerData: {
          conversationRequestId: 'req-1', traceId: '11111111111111111111111111111111',
          usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
        },
      }),
      userLine({
        id: 'u2', timestamp: 3_000, providerData: { agent: 'cli', conversationRequestId: 'req-2' },
        _meta: { traceparent: '00-33333333333333333333333333333333-4444444444444444-01' },
      }),
      assistantLine({
        id: 'a2', timestamp: 4_000,
        _meta: { traceparent: '00-33333333333333333333333333333333-4444444444444444-01' },
        providerData: {
          conversationRequestId: 'req-2', traceId: '33333333333333333333333333333333',
          usage: { inputTokens: 20, outputTokens: 2, totalTokens: 22 },
        },
      }),
    ]), 'sess-1');

    expect(conv!.index.requests).toHaveLength(2);
    // Per-turn native trace ids — no session-level mega-trace.
    const t1 = JSON.parse(conv!.messages[0].extra!).traceId;
    const t2 = JSON.parse(conv!.messages[2].extra!).traceId;
    expect(t1).toBe('11111111111111111111111111111111');
    expect(t2).toBe('33333333333333333333333333333333');
  });

  it('marks a turn without an assistant message incomplete (fast cancel)', () => {
    const conv = parseRolloutConversation(toJsonl([
      userLine({ id: 'u1', timestamp: 1_000 }),
      // No assistant line — the run was aborted before any response.
    ]), 'sess-1');
    expect(conv!.index.requests).toHaveLength(1);
    expect(conv!.index.requests![0].state).toBe('incomplete');
  });

  it('maps function_call and function_call_result items to tool messages', () => {
    const conv = parseRolloutConversation(toJsonl([
      userLine({ id: 'u1', timestamp: 1_000 }),
      {
        type: 'function_call', callId: 'call-1', id: 'fc-1', name: 'read_file',
        arguments: '{"path":"a.txt"}', timestamp: 2_000,
        providerData: { conversationRequestId: 'req-1' },
        _meta: { traceparent: '00-9d1ca988b89868a4dcb007bdee4adf24-ae6eddfece965065-01' },
      },
      {
        type: 'function_call_result', callId: 'call-1', output: 'file content', timestamp: 3_000,
        providerData: { conversationRequestId: 'req-1' },
        _meta: { traceparent: '00-9d1ca988b89868a4dcb007bdee4adf24-ae6eddfece965065-01' },
      },
      assistantLine({ id: 'a1', timestamp: 4_000, content: [{ type: 'output_text', text: 'done' }] }),
    ]), 'sess-1');

    expect(conv!.messages).toHaveLength(4);
    const call = conv!.messages[1];
    expect(call.role).toBe('assistant');
    expect(JSON.parse(call.message).content[0]).toEqual({
      type: 'tool-call', toolCallId: 'call-1', toolName: 'read_file', args: { path: 'a.txt' },
    });
    const result = conv!.messages[2];
    expect(result.role).toBe('tool');
    expect(JSON.parse(result.message).content[0]).toEqual({
      type: 'tool-result', toolCallId: 'call-1', result: 'file content',
    });
    // The turn ends with an assistant message → complete.
    expect(conv!.index.requests![0].state).toBe('complete');
  });

  it('splits a user line carrying tool results into a user + tool message pair', () => {
    const conv = parseRolloutConversation(toJsonl([
      userLine({
        id: 'u1', timestamp: 1_000,
        content: [
          { type: 'input_text', text: 'check' },
          { type: 'tool_result', call_id: 'call-9', output: 'ok' },
        ],
      }),
    ]), 'sess-1');
    expect(conv!.messages).toHaveLength(2);
    expect(conv!.messages[0].role).toBe('user');
    expect(conv!.messages[1].role).toBe('tool');
    expect(JSON.parse(conv!.messages[1].message).content[0]).toEqual({
      type: 'tool-result', toolCallId: 'call-9', result: 'ok',
    });
    // Both synthesized messages belong to the same request.
    expect(conv!.index.requests![0].messages).toEqual(['u1', 'u1:tools']);
  });

  it('tolerates malformed lines and non-message record types', () => {
    const raw = [
      '{"type":"message","role":"user"', // broken JSON
      'not json at all',
      JSON.stringify({ type: 'unknown-future-type', timestamp: 1 }),
      JSON.stringify(userLine()),
      '',
    ].join('\n');
    const conv = parseRolloutConversation(raw, 'sess-1');
    expect(conv).not.toBeNull();
    expect(conv!.messages).toHaveLength(1);
  });

  it('falls back to a stable synthetic request id when none is carried', () => {
    const line = userLine();
    delete (line as { providerData?: unknown }).providerData;
    delete (line as { _meta?: unknown })._meta;
    const conv = parseRolloutConversation(JSON.stringify(line) + '\n', 'sess-1');
    expect(conv!.index.requests![0].id).toBe('sess-1:t1');
  });
});

describe('CodeBuddyRolloutInput availability', () => {
  it('checks ~/.codebuddy (platform-neutral, all three OSes)', async () => {
    // The test globalSetup redirects HOME, so probe an explicit fixture home.
    const home = await mkdtemp(path.join(tmpdir(), 'codebuddy-cli-home-'));
    try {
      expect(await CodeBuddyRolloutInput.checkAvailability(home)).toBe(false);
      await mkdir(path.join(home, '.codebuddy'), { recursive: true });
      expect(await CodeBuddyRolloutInput.checkAvailability(home)).toBe(true);
      expect(CodeBuddyRolloutInput.getWatchPaths(home)[0]).toBe(path.join(home, '.codebuddy'));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('CodeBuddyRolloutInput collect (last-turn sealing)', () => {
  async function makeInput(root: string, slug: string, sessionFile: string) {
    // Layout matches production: rolloutRoot/<cwd-slug>/<sessionId>.jsonl.
    const rolloutRoot = path.join(root, 'projects');
    const slugDir = path.join(rolloutRoot, slug);
    await mkdir(slugDir, { recursive: true });
    const filePath = path.join(slugDir, sessionFile);
    const stateStore = new StateStore(path.join(root, 'state.json'));
    const input = new CodeBuddyRolloutInput({ stateStore, rolloutRoot });
    return { filePath, stateStore, input };
  }

  const collect = (input: CodeBuddyRolloutInput) =>
    (input as unknown as { collect(): Promise<Array<Record<string, unknown>>> }).collect();

  const seedRuntime = (stateStore: StateStore, sessionId: string, boundaryMs: number) => {
    stateStore.update('codebuddy', {
      extra: { boundaries: { [sessionId]: { prompts: [boundaryMs] } } },
    });
    stateStore.update('codebuddy-rollout', {
      extra: {
        codebuddyRolloutInitialized: true,
        codebuddyRolloutProcessed: {},
        codebuddyRolloutMtime: {},
      },
    });
  };

  it('does not seal a streaming last turn on its own prompt boundary; emits usage once the assistant lands', async () => {
    // Regression (real macOS trace): the turn's own UserPromptSubmit boundary
    // fires ~1s after the user line lands, while the model is still streaming.
    // Sealing then marked the request processed and the assistant line's
    // usage/output were lost forever.
    const root = await mkdtemp(path.join(tmpdir(), 'codebuddy-roll-'));
    try {
      const { filePath, stateStore, input } = await makeInput(root, 'slug', 'sess-live.jsonl');
      await writeFile(filePath, toJsonl([userLine()]));
      seedRuntime(stateStore, 'sess-live', 1_733_000_000_000);

      // Collect while the model is still streaming (fresh mtime): nothing may
      // be emitted and nothing may be marked processed.
      const fresh = await collect(input);
      expect(fresh).toEqual([]);

      // The assistant lands later — the settled path emits with usage.
      await writeFile(filePath, toJsonl([userLine(), assistantLine()]));
      const after = await collect(input);
      expect(after.map(entry => entry['event.name'])).toEqual(['llm.request', 'llm.response']);
      expect(after[1]['gen_ai.usage.input_tokens']).toBe(18897);
      expect(after[1]['gen_ai.response.finish_reasons']).toEqual(['stop']);
      expect(after[1]['gen_ai.turn.end']).toBe(true);

      // And the next cycle stays quiet.
      expect(await collect(input)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('seals an incomplete last turn as cancelled once the rollout has gone quiet, pairing it with the request step', async () => {
    // Fast-cancelled run: user line only, the CLI stops writing (quiet file),
    // no Stop hook fires. The cancelled seal must pair with the request-only
    // llm.request step (same step id) or the flusher drops the user prompt.
    const root = await mkdtemp(path.join(tmpdir(), 'codebuddy-roll-'));
    try {
      const { filePath, stateStore, input } = await makeInput(root, 'slug', 'sess-cancelled.jsonl');
      await writeFile(filePath, toJsonl([userLine()]));
      // Simulate a run that ended a while ago: quiet file.
      const quietAt = new Date(Date.now() - 30_000);
      await utimes(filePath, quietAt, quietAt);
      seedRuntime(stateStore, 'sess-cancelled', 1_733_000_000_000);

      const entries = await collect(input);
      expect(entries.map(entry => entry['event.name'])).toEqual(['llm.request', 'llm.response']);
      // Shared step id → the flusher pairs request + cancelled response.
      const stepIds = entries.map(entry => entry['gen_ai.step.id']);
      expect(stepIds[0]).toBe(stepIds[1]);
      expect(entries[0]['gen_ai.input.messages_delta']).toHaveLength(1);
      expect(entries[1]['gen_ai.response.finish_reasons']).toEqual(['cancelled']);
      expect(entries[1]['gen_ai.turn.end']).toBe(true);

      expect(await collect(input)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
