import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { StateStore } from '../../../src/checkpoints/state-store.js';
import { buildCodeBuddyHistoryEvents } from '../../../src/inputs/codebuddy/codebuddy-history-builder.js';
import {
  CodeBuddyHistoryInput,
  __testing,
} from '../../../src/inputs/codebuddy/codebuddy-history-input.js';
import type {
  CodeBuddyHistoryConversation,
  CodeBuddyHistoryMessage,
} from '../../../src/inputs/codebuddy/codebuddy-history-types.js';

const { settledRequestIds, candidateDataRoots } = __testing;

afterEach(async () => {
  // Vitest cleans tmp dirs lazily; explicit rm keeps CI storage flat.
});

function message(
  id: string,
  role: string,
  inner: Record<string, unknown>,
  extra?: Record<string, unknown>,
  createdAt = '2026-10-30T01:45:25.590Z',
): CodeBuddyHistoryMessage {
  return {
    id,
    role,
    message: JSON.stringify(inner),
    ...(extra !== undefined ? { extra: JSON.stringify(extra) } : {}),
    createdAt,
  };
}

function conversation(overrides: Partial<CodeBuddyHistoryConversation> = {}): CodeBuddyHistoryConversation {
  return {
    conversationId: 'conv-1',
    index: {},
    messages: [],
    ...overrides,
  };
}

describe('codebuddy history builder', () => {
  it('emits request/response/tool events with usage for a two-step turn', async () => {
    const traceId = 'a'.repeat(32);
    const conv = conversation({
      index: {
        requests: [{
          id: 'req-1',
          messages: ['u1', 'a1', 't1', 'a2'],
          state: 'complete',
          startedAt: 1793324725552,
          usage: {
            inputTokens: 3051,
            outputTokens: 42,
            totalTokens: 3093,
            cacheTokens: 7,
            cachedWriteTokens: 3,
            credit: 12,
          },
        }],
      },
      messages: [
        message('u1', 'user', {
          role: 'user',
          content: [{ type: 'text', text: '<user_info>ignore</user_info><user_query>hi</user_query>' }],
        }, {
          requestId: 'req-1',
          traceId,
          sourceContentBlocks: [{ type: 'text', text: 'hi' }],
        }),
        message('a1', 'assistant', {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'thinking...' },
            { type: 'tool-call', toolCallId: 'call-1', toolName: 'web_fetch', args: { url: 'https://x' } },
          ],
        }, { requestId: 'req-1', traceId, responseId: 'resp-1' }),
        message('t1', 'tool', {
          role: 'tool',
          content: [{
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'web_fetch',
            result: { status: 'success', success: true },
          }],
        }),
        message('a2', 'assistant', {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
        }, {
          requestId: 'req-1',
          traceId,
          responseId: 'resp-2',
          statsSnapshot: { inputTokens: 3051, outputTokens: 42, credit: 12 },
        }),
      ],
    });

    const entries = await buildCodeBuddyHistoryEvents(conv).entries;
    const names = entries.map(entry => entry['event.name']);

    expect(names).toEqual([
      'llm.request',
      'llm.response',
      'tool.call',
      'tool.result',
      'llm.request',
      'llm.response',
    ]);

    // User prompt uses sourceContentBlocks (wrapper stripped).
    const firstRequest = entries[0];
    const delta = firstRequest['gen_ai.input.messages_delta'] as Array<Record<string, unknown>>;
    expect(delta[0].role).toBe('user');
    expect(JSON.stringify(delta[0].parts)).toContain('"hi"');
    expect(JSON.stringify(delta[0].parts)).not.toContain('user_info');

    // Tool call/result linkage.
    const toolCall = entries.find(entry => entry['event.name'] === 'tool.call');
    const toolResult = entries.find(entry => entry['event.name'] === 'tool.result');
    expect(toolCall?.['gen_ai.tool.name']).toBe('web_fetch');
    expect(toolCall?.['gen_ai.tool.call.id']).toBe('call-1');
    expect(toolResult?.['gen_ai.tool.call.id']).toBe('call-1');
    expect(toolResult?.['tool.result.status']).toBe('success');

    // Usage lands on the sealing response only.
    const lastResponse = entries[entries.length - 1];
    expect(lastResponse['gen_ai.usage.input_tokens']).toBe(3051);
    expect(lastResponse['gen_ai.usage.output_tokens']).toBe(42);
    expect(lastResponse['gen_ai.usage.total_tokens']).toBe(3093);
    expect(lastResponse['gen_ai.usage.cache_read.input_tokens']).toBe(7);
    expect(lastResponse['gen_ai.usage.cache_creation.input_tokens']).toBe(3);
    expect(lastResponse['agent.codebuddy.usage.credit']).toBe(12);
    expect(lastResponse['gen_ai.turn.end']).toBe(true);
    expect(lastResponse['gen_ai.response.finish_reasons']).toEqual(['stop']);
    expect(lastResponse['gen_ai.response.id']).toBe('resp-2');

    // Turn starts once.
    const startCount = entries.filter(entry => entry['gen_ai.turn.start'] === true).length;
    expect(startCount).toBe(1);

    // Shared trace id across the whole request.
    const traceIds = new Set(entries.map(entry => entry['trace_id']));
    expect(traceIds.size).toBe(1);
    expect(traceIds.has(traceId)).toBe(true);
  });

  it('withholds a tool-call-ending turn with no boundary evidence (emits nothing unsealed)', () => {
    const conv = conversation({
      index: {
        requests: [{
          id: 'req-1',
          messages: ['u1', 'a1'],
          state: 'complete',
          startedAt: 1,
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        }],
      },
      messages: [
        message('u1', 'user', { role: 'user', content: [{ type: 'text', text: 'q' }] }, { traceId: 'b'.repeat(32) }),
        message('a1', 'assistant', {
          role: 'assistant',
          content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'T', args: {} }],
        }),
      ],
    });

    // Emitting an unsealed tool-call-ending turn would strand its records in
    // the flusher's turn buffer forever (no terminal finish reason, no
    // turn.end), so the builder withholds the whole turn instead.
    const result = buildCodeBuddyHistoryEvents(conv);
    expect(result.entries).toEqual([]);
    expect(result.unsealedRequestIds).toEqual(['req-1']);
  });

  it('seals tool-call-ending turns at the hook Stop boundary', () => {
    const stopAtMs = 1_733_000_000_000;
    const conv = conversation({
      index: {
        requests: [{
          id: 'req-1',
          messages: ['u1', 'a1'],
          state: 'complete',
          startedAt: stopAtMs - 5_000,
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        }],
      },
      messages: [
        message('u1', 'user', { role: 'user', content: [{ type: 'text', text: 'q' }] }, { traceId: 'b'.repeat(32) }, new Date(stopAtMs - 5_000).toISOString()),
        message('a1', 'assistant', {
          role: 'assistant',
          content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'T', args: {} }],
        }, undefined, new Date(stopAtMs - 4_000).toISOString()),
      ],
    });

    const entries = buildCodeBuddyHistoryEvents(conv, { sealEvidence: [stopAtMs] }).entries;
    const seal = entries.find(entry => entry['event.name'] === 'other');
    expect(seal).toBeDefined();
    expect(seal?.['gen_ai.turn.end']).toBe(true);
    expect(seal?.['gen_ai.turn.id']).toBe('req-1');
    expect(seal?.['time_unix_nano']).toBe(String(BigInt(stopAtMs) * 1_000_000n));
    // No fabricated cancelled response for a completed run.
    expect(entries.filter(entry => entry['event.name'] === 'llm.response').length).toBe(1);
  });

  it('seals a cancelled run with a minimal cancelled response, preserving the user prompt', () => {
    const stopAtMs = 1_733_000_000_000;
    const conv = conversation({
      index: {
        requests: [{
          id: 'req-1',
          messages: ['u1'],
          // No state: the run was cancelled before any response landed.
          startedAt: stopAtMs - 2_000,
        }],
      },
      messages: [
        message('u1', 'user', { role: 'user', content: [{ type: 'text', text: 'urgent question' }] },
          { traceId: 'b'.repeat(32) }, new Date(stopAtMs - 2_000).toISOString()),
      ],
    });

    const entries = buildCodeBuddyHistoryEvents(conv, {
      includeRequestIds: new Set(['req-1']),
      sealEvidence: [stopAtMs],
    }).entries;
    const names = entries.map(entry => entry['event.name']);
    expect(names).toEqual(['llm.request', 'llm.response']);

    // The user prompt survives the cancellation via the request delta.
    const request = entries[0];
    const delta = request['gen_ai.input.messages_delta'] as Array<Record<string, unknown>>;
    expect(JSON.stringify(delta[0].parts)).toContain('urgent question');
    expect(request['gen_ai.turn.start']).toBe(true);

    const cancelled = entries[1] as Record<string, unknown>;
    expect(cancelled['gen_ai.response.finish_reasons']).toEqual(['cancelled']);
    expect(cancelled['gen_ai.turn.end']).toBe(true);
    expect(cancelled['time_unix_nano']).toBe(String(BigInt(stopAtMs) * 1_000_000n));
    // No fabricated output content.
    expect(cancelled['gen_ai.output.messages']).toBeUndefined();
  });

  it('does not seal turns newer than the Stop boundary (still in flight)', () => {
    const stopAtMs = 1_733_000_000_000;
    const conv = conversation({
      index: {
        requests: [{
          id: 'req-1',
          messages: ['u1', 'a1'],
          state: 'complete',
          startedAt: stopAtMs - 1_000,
          // createdAt well after the Stop → clock-skew / in-flight guard.
        }],
      },
      messages: [
        message('u1', 'user', { role: 'user', content: [{ type: 'text', text: 'q' }] }, { traceId: 'b'.repeat(32) }, new Date(stopAtMs - 500).toISOString()),
        message('a1', 'assistant', {
          role: 'assistant',
          content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'T', args: {} }],
        }, undefined, new Date(stopAtMs + 60_000).toISOString()),
      ],
    });

    const result = buildCodeBuddyHistoryEvents(conv, { sealEvidence: [stopAtMs] });
    // The in-flight turn is withheld entirely — emitting it would strand the
    // records in the flusher's turn buffer forever.
    expect(result.entries.some(entry => entry['gen_ai.turn.end'] === true)).toBe(false);
    expect(result.entries).toEqual([]);
    expect(result.unsealedRequestIds).toEqual(['req-1']);
  });

  it('seals an aborted turn at the next UserPromptSubmit boundary (no Stop emitted)', () => {
    // CodeBuddy does not emit Stop when the user aborts a running turn; the
    // next prompt submit is the only client-observed end signal.
    const promptAtMs = 1_733_000_000_000;
    const conv = conversation({
      index: {
        requests: [{
          id: 'req-1',
          messages: ['u1', 'a1'],
          // CodeBuddy marks aborted runs complete in the store — the abort is
          // only visible through the missing Stop and the dangling tool call.
          state: 'complete',
          startedAt: promptAtMs - 10_000,
        }],
      },
      messages: [
        message('u1', 'user', { role: 'user', content: [{ type: 'text', text: 'q' }] }, { traceId: 'b'.repeat(32) }, new Date(promptAtMs - 10_000).toISOString()),
        message('a1', 'assistant', {
          role: 'assistant',
          content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'T', args: {} }],
        }, undefined, new Date(promptAtMs - 5_000).toISOString()),
      ],
    });

    const entries = buildCodeBuddyHistoryEvents(conv, { sealEvidence: [promptAtMs] }).entries;
    const seal = entries.find(entry => entry['event.name'] === 'other');
    expect(seal).toBeDefined();
    expect(seal?.['gen_ai.turn.end']).toBe(true);
    expect(seal?.['time_unix_nano']).toBe(String(BigInt(promptAtMs) * 1_000_000n));
  });

  it('seals an open turn at the next request start without any hook evidence', () => {
    const laterStartMs = 1_733_000_000_000;
    const conv = conversation({
      index: {
        requests: [
          {
            id: 'req-1',
            messages: ['u1', 'a1'],
            state: 'complete',
            startedAt: laterStartMs - 10_000,
          },
          {
            id: 'req-2',
            messages: ['u2', 'a2'],
            state: 'complete',
            startedAt: laterStartMs,
          },
        ],
      },
      messages: [
        message('u1', 'user', { role: 'user', content: [{ type: 'text', text: 'q1' }] }, { traceId: 'b'.repeat(32) }, new Date(laterStartMs - 10_000).toISOString()),
        message('a1', 'assistant', {
          role: 'assistant',
          content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'T', args: {} }],
        }, undefined, new Date(laterStartMs - 5_000).toISOString()),
        message('u2', 'user', { role: 'user', content: [{ type: 'text', text: 'q2' }] }, { traceId: 'c'.repeat(32) }, new Date(laterStartMs).toISOString()),
        message('a2', 'assistant', { role: 'assistant', content: [{ type: 'text', text: 'done' }] }, undefined, new Date(laterStartMs + 1_000).toISOString()),
      ],
    });

    // A later cycle rebuilds both requests together (req-1 was withheld last
    // cycle, so it was never marked processed): req-1's open turn is sealed
    // by req-2's start even with no hook evidence at all, and req-2 — a
    // plain-text ending — seals natively.
    const entries = buildCodeBuddyHistoryEvents(conv, {
      includeRequestIds: new Set(['req-1', 'req-2']),
      sealEvidence: [],
    }).entries;
    const seal = entries.find(entry => entry['event.name'] === 'other');
    expect(seal).toBeDefined();
    expect(seal?.['gen_ai.turn.id']).toBe('req-1');
    expect(seal?.['gen_ai.turn.end']).toBe(true);
    expect(entries.some(entry => entry['gen_ai.step.id'] === 'req-1:s1' && entry['event.name'] === 'llm.request')).toBe(true);
    expect(entries.some(entry => entry['gen_ai.step.id'] === 'req-2:s1' && entry['event.name'] === 'llm.request')).toBe(true);
  });

  it('skips helper messages and empty requests', () => {
    const conv = conversation({
      index: {
        requests: [
          { id: 'req-1', messages: ['h1'], state: 'complete', startedAt: 1 },
          { id: 'req-2', messages: [], state: 'complete', startedAt: 2 },
        ],
      },
      messages: [
        message('h1', 'user', { role: 'user', content: [] }, { isHelperMessage: true }),
      ],
    });
    expect(buildCodeBuddyHistoryEvents(conv).entries).toEqual([]);
  });

  it('falls back to inner text when sourceContentBlocks are absent', () => {
    const conv = conversation({
      index: {
        requests: [{ id: 'req-1', messages: ['u1', 'a1'], state: 'complete', startedAt: 1 }],
      },
      messages: [
        message('u1', 'user', { role: 'user', content: [{ type: 'text', text: 'plain' }] }),
        message('a1', 'assistant', { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }),
      ],
    });
    const entries = buildCodeBuddyHistoryEvents(conv).entries;
    const delta = entries[0]['gen_ai.input.messages_delta'] as Array<Record<string, unknown>>;
    expect(JSON.stringify(delta[0].parts)).toContain('plain');
  });
});

describe('settledRequestIds', () => {
  it('treats complete requests as settled and pending last request as unsettled', () => {
    const ids = settledRequestIds([
      { id: 'a', state: 'complete' },
      { id: 'b', state: 'pending' },
      { id: 'c' },
    ]);
    expect(ids).toEqual(['a']);
  });

  it('treats an unknown-state last request as unsettled but earlier ones as settled', () => {
    const ids = settledRequestIds([
      { id: 'a' },
      { id: 'b' },
    ]);
    expect(ids).toEqual(['a']);
  });
});

describe('candidateDataRoots', () => {
  it('uses LOCALAPPDATA on win32', () => {
    const roots = candidateDataRoots({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, 'C:\\Users\\x');
    expect(roots).toContain('C:\\Users\\x\\AppData\\Local\\CodeBuddyExtension\\Data');
  });

  it('falls back to home-derived paths when env is missing', () => {
    const roots = candidateDataRoots({}, 'C:\\Users\\x');
    expect(roots).toContain(path.join('C:\\Users\\x', 'AppData', 'Local', 'CodeBuddyExtension', 'Data'));
  });

  it('probes APPDATA (Roaming) on win32 per the official FAQ', () => {
    const roots = candidateDataRoots({
      LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local',
      APPDATA: 'C:\\Users\\x\\AppData\\Roaming',
    }, 'C:\\Users\\x');
    expect(roots).toContain('C:\\Users\\x\\AppData\\Roaming\\CodeBuddyExtension\\Data');
    expect(roots[0]).toBe('C:\\Users\\x\\AppData\\Local\\CodeBuddyExtension\\Data');
  });

  it('prefers Application Support on darwin (Electron userData, official FAQ)', () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      const roots = candidateDataRoots({}, '/Users/x');
      expect(roots[0]).toBe(path.join('/Users/x', 'Library', 'Application Support', 'CodeBuddyExtension', 'Data'));
      expect(roots).toContain(path.join('/Users/x', 'Library', 'Caches', 'CodeBuddyExtension', 'Data'));
    } finally {
      Object.defineProperty(process, 'platform', descriptor);
    }
  });

  it('prefers ~/.config on linux (Electron userData) with cache candidates', () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      const roots = candidateDataRoots({}, '/home/x');
      expect(roots[0]).toBe(path.join('/home/x', '.config', 'CodeBuddyExtension', 'Data'));
      expect(roots).toContain(path.join('/home/x', '.cache', 'CodeBuddyExtension', 'Data'));
      expect(roots).toContain(path.join('/home/x', '.local', 'share', 'CodeBuddyExtension', 'Data'));
    } finally {
      Object.defineProperty(process, 'platform', descriptor);
    }
  });
});

describe('CodeBuddyHistoryInput', () => {
  it('collects new requests incrementally', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codebuddy-hist-'));
    try {
      const convDir = path.join(
        root, 'default', 'CodeBuddyIDE', 'tok', 'history', 'ws', 'conv-1',
      );
      await mkdir(path.join(convDir, 'messages'), { recursive: true });
      const writeHistory = async (withSecond: boolean) => {
        const requests: Array<Record<string, unknown>> = [{
          id: 'req-1', messages: ['u1', 'a1'], state: 'complete', startedAt: 1,
          usage: { inputTokens: 11, outputTokens: 2, totalTokens: 13 },
        }];
        if (withSecond) {
          requests.push({
            id: 'req-2', messages: ['u2', 'a2'], state: 'complete', startedAt: 2,
            usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 },
          });
        }
        await writeFile(path.join(convDir, 'index.json'), JSON.stringify({ requests }));
        await writeFile(path.join(convDir, 'messages', 'u1.json'), JSON.stringify(
          message('u1', 'user', { role: 'user', content: [{ type: 'text', text: 'one' }] }, { traceId: 'c'.repeat(32) }),
        ));
        await writeFile(path.join(convDir, 'messages', 'a1.json'), JSON.stringify(
          message('a1', 'assistant', { role: 'assistant', content: [{ type: 'text', text: 'r1' }] }),
        ));
        if (withSecond) {
          await writeFile(path.join(convDir, 'messages', 'u2.json'), JSON.stringify(
            message('u2', 'user', { role: 'user', content: [{ type: 'text', text: 'two' }] }, { traceId: 'c'.repeat(32) }),
          ));
          await writeFile(path.join(convDir, 'messages', 'a2.json'), JSON.stringify(
            message('a2', 'assistant', { role: 'assistant', content: [{ type: 'text', text: 'r2' }] }),
          ));
        }
      };

      const stateStore = new StateStore(path.join(root, 'state.json'));
      const input = new CodeBuddyHistoryInput({ stateStore, dataRoots: [root] });

      // First cycle: baseline, everything marked processed, no replay.
      await (input as unknown as { onStart(): Promise<void> }).onStart();
      const baseline = await (input as unknown as { collect(): Promise<unknown[]> }).collect();
      expect(baseline).toEqual([]);

      // Append a second request, bump mtime, then collect again.
      await writeHistorySecondRound(convDir);
      const second = await (input as unknown as { collect(): Promise<Array<Record<string, unknown>>> }).collect();
      const names = second.map(entry => entry['event.name']);
      expect(names).toContain('llm.request');
      expect(names).toContain('llm.response');
      const last = second[second.length - 1];
      expect(last['gen_ai.usage.input_tokens']).toBe(20);

      // Third cycle: no duplicate emission.
      const third = await (input as unknown as { collect(): Promise<unknown[]> }).collect();
      expect(third).toEqual([]);
      await (input as unknown as { onStop(): Promise<void> }).onStop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('collects conversations from every client product (IDE, VSCode and JetBrains plugins)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codebuddy-hist-'));
    try {
      // Regression: discovery used to hardcode the `CodeBuddyIDE` product
      // directory, silently dropping plugin conversations persisted under
      // `VSCode` / `JetBrains` (identical layout, verified against real stores).
      const products = ['CodeBuddyIDE', 'VSCode', 'JetBrains'];
      for (const [i, product] of products.entries()) {
        const convDir = path.join(
          root, 'default', product, 'tok', 'history', 'ws', `conv-${product}`,
        );
        await mkdir(path.join(convDir, 'messages'), { recursive: true });
        await writeFile(path.join(convDir, 'index.json'), JSON.stringify({
          requests: [{
            id: `req-${product}`, messages: ['u1', 'a1'], state: 'complete', startedAt: 1,
            usage: { inputTokens: 10 + i, outputTokens: 2, totalTokens: 12 + i },
          }],
        }));
        await writeFile(path.join(convDir, 'messages', 'u1.json'), JSON.stringify(
          message('u1', 'user', { role: 'user', content: [{ type: 'text', text: product }] },
            { traceId: 'c'.repeat(32) }),
        ));
        await writeFile(path.join(convDir, 'messages', 'a1.json'), JSON.stringify(
          message('a1', 'assistant', { role: 'assistant', content: [{ type: 'text', text: 'r1' }] }),
        ));
      }

      const stateStore = new StateStore(path.join(root, 'state.json'));
      const input = new CodeBuddyHistoryInput({ stateStore, dataRoots: [root] });
      await (input as unknown as { onStart(): Promise<void> }).onStart();
      // Baseline cycle marks everything processed; emit by clearing the
      // processed map is overkill — instead bump one conversation with a new
      // request and assert each product surfaces exactly its own conversation.
      await (input as unknown as { collect(): Promise<unknown[]> }).collect();

      // Simulate a follow-up turn in the JetBrains plugin conversation.
      const jbDir = path.join(
        root, 'default', 'JetBrains', 'tok', 'history', 'ws', 'conv-JetBrains',
      );
      await writeFile(path.join(jbDir, 'index.json'), JSON.stringify({
        requests: [
          { id: 'req-JetBrains', messages: ['u1', 'a1'], state: 'complete', startedAt: 1 },
          {
            id: 'req-JetBrains-2', messages: ['u2', 'a2'], state: 'complete', startedAt: 2,
            usage: { inputTokens: 30, outputTokens: 5, totalTokens: 35 },
          },
        ],
      }));
      await writeFile(path.join(jbDir, 'messages', 'u2.json'), JSON.stringify(
        message('u2', 'user', { role: 'user', content: [{ type: 'text', text: 'two' }] },
          { traceId: 'c'.repeat(32) }),
      ));
      await writeFile(path.join(jbDir, 'messages', 'a2.json'), JSON.stringify(
        message('a2', 'assistant', { role: 'assistant', content: [{ type: 'text', text: 'r2' }] }),
      ));

      const events = await (input as unknown as { collect(): Promise<Array<Record<string, unknown>>> }).collect();
      const sessions = new Set(
        events.map(entry => entry['gen_ai.session.id']).filter(Boolean),
      );
      expect(sessions).toContain('conv-JetBrains');
      expect(events.some(entry => entry['gen_ai.usage.input_tokens'] === 30)).toBe(true);
      await (input as unknown as { onStop(): Promise<void> }).onStop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('seals a cancelled newest request via the hook Stop boundary from the hook input state', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codebuddy-hist-'));
    try {
      const convDir = path.join(
        root, 'default', 'CodeBuddyIDE', 'tok', 'history', 'ws', 'conv-cancel',
      );
      await mkdir(path.join(convDir, 'messages'), { recursive: true });
      const stopAtMs = 1_733_000_000_000;
      await writeFile(path.join(convDir, 'index.json'), JSON.stringify({
        requests: [{
          id: 'req-x', messages: ['u1'], startedAt: stopAtMs - 2_000,
          // No state: cancelled before the store recorded anything.
        }],
      }));
      await writeFile(path.join(convDir, 'messages', 'u1.json'), JSON.stringify(
        message('u1', 'user', { role: 'user', content: [{ type: 'text', text: 'quick' }] },
          { traceId: 'd'.repeat(32) }, new Date(stopAtMs - 1_500).toISOString()),
      ));

      const stateStore = new StateStore(path.join(root, 'state.json'));
      const input = new CodeBuddyHistoryInput({ stateStore, dataRoots: [root] });
      await (input as unknown as { onStart(): Promise<void> }).onStart();

      // Baseline cycle: settled list is empty, nothing emitted yet.
      const baseline = await (input as unknown as { collect(): Promise<unknown[]> }).collect();
      expect(baseline).toEqual([]);

      // The hook input (same StateStore, id 'codebuddy') published a Stop.
      stateStore.update('codebuddy', {
        extra: { boundaries: { 'conv-cancel': { stops: [stopAtMs] } } },
      });
      const sealed = await (input as unknown as { collect(): Promise<Array<Record<string, unknown>>> }).collect();
      const names = sealed.map(entry => entry['event.name']);
      expect(names).toEqual(['llm.request', 'llm.response']);
      const cancelled = sealed[1];
      expect(cancelled['gen_ai.response.finish_reasons']).toEqual(['cancelled']);
      expect(cancelled['gen_ai.turn.end']).toBe(true);

      // Sealing is final: no re-emission on the next cycle.
      const third = await (input as unknown as { collect(): Promise<unknown[]> }).collect();
      expect(third).toEqual([]);
      await (input as unknown as { onStop(): Promise<void> }).onStop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('withholds an unsealed newest turn until boundary evidence arrives (input-level)', async () => {
    // User aborts a running tool-call turn: the store marks the request
    // complete, but CodeBuddy never emits Stop. The turn's records must not
    // be emitted until evidence arrives — otherwise they strand in the
    // flusher's turn buffer and the backend sees nothing (the reported gap).
    const root = await mkdtemp(path.join(tmpdir(), 'codebuddy-hist-'));
    try {
      const convDir = path.join(
        root, 'default', 'CodeBuddyIDE', 'tok', 'history', 'ws', 'conv-abort',
      );
      await mkdir(path.join(convDir, 'messages'), { recursive: true });
      // Baseline runs while the aborted turn is not yet on disk.
      await writeFile(path.join(convDir, 'index.json'), JSON.stringify({ requests: [] }));
      const promptAtMs = 1_733_000_000_000;
      await writeFile(path.join(convDir, 'messages', 'u1.json'), JSON.stringify(
        message('u1', 'user', { role: 'user', content: [{ type: 'text', text: 'build it' }] },
          { traceId: 'e'.repeat(32) }, new Date(promptAtMs - 10_000).toISOString()),
      ));
      await writeFile(path.join(convDir, 'messages', 'a1.json'), JSON.stringify(
        message('a1', 'assistant', {
          role: 'assistant',
          content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'T', args: {} }],
        }, undefined, new Date(promptAtMs - 5_000).toISOString()),
      ));

      const stateStore = new StateStore(path.join(root, 'state.json'));
      const input = new CodeBuddyHistoryInput({ stateStore, dataRoots: [root] });
      await (input as unknown as { onStart(): Promise<void> }).onStart();

      // Baseline: everything on disk is marked processed without replay.
      const baseline = await (input as unknown as { collect(): Promise<unknown[]> }).collect();
      expect(baseline).toEqual([]);

      // The aborted turn is written after the baseline (mtime bump): rebuilt
      // with NO evidence — withheld, not emitted, not marked processed.
      await writeFile(path.join(convDir, 'index.json'), JSON.stringify({
        requests: [{
          id: 'req-a', messages: ['u1', 'a1'],
          // Aborted runs are still recorded as complete in the store.
          state: 'complete', startedAt: promptAtMs - 10_000,
        }],
      }));
      const withheld = await (input as unknown as { collect(): Promise<unknown[]> }).collect();
      expect(withheld).toEqual([]);

      // The user submits the next prompt: UserPromptSubmit boundary evidence.
      stateStore.update('codebuddy', {
        extra: { boundaries: { 'conv-abort': { stops: [], prompts: [promptAtMs] } } },
      });
      const sealed = await (input as unknown as { collect(): Promise<Array<Record<string, unknown>>> }).collect();
      const names = sealed.map(entry => entry['event.name']);
      expect(names).toContain('llm.request');
      expect(names).toContain('tool.call');
      const seal = sealed.find(entry => entry['event.name'] === 'other');
      expect(seal?.['gen_ai.turn.end']).toBe(true);
      expect(seal?.['time_unix_nano']).toBe(String(BigInt(promptAtMs) * 1_000_000n));

      // Sealing is final: no re-emission on the next cycle.
      const third = await (input as unknown as { collect(): Promise<unknown[]> }).collect();
      expect(third).toEqual([]);
      await (input as unknown as { onStop(): Promise<void> }).onStop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function writeHistorySecondRound(convDir: string): Promise<void> {
  await writeFile(path.join(convDir, 'index.json'), JSON.stringify({
    requests: [
      { id: 'req-1', messages: ['u1', 'a1'], state: 'complete', startedAt: 1 },
      {
        id: 'req-2', messages: ['u2', 'a2'], state: 'complete', startedAt: 2,
        usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 },
      },
    ],
  }));
  await writeFile(path.join(convDir, 'messages', 'u2.json'), JSON.stringify(
    message('u2', 'user', { role: 'user', content: [{ type: 'text', text: 'two' }] }, { traceId: 'c'.repeat(32) }),
  ));
  await writeFile(path.join(convDir, 'messages', 'a2.json'), JSON.stringify(
    message('a2', 'assistant', { role: 'assistant', content: [{ type: 'text', text: 'r2' }] }),
  ));
}
