import { describe, expect, it } from 'vitest';
import { ClientType } from '../../../../src/types/index.js';
import {
  transformDshRecordEntries,
  newState,
} from '../../../../src/inputs/dsh/dsh-event-transform.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';

// Incremental-payload contract for dsh llm.request correlation. The input
// accumulator is turn-scoped, so re-sending the full `gen_ai.input.messages`
// snapshot on every step duplicates the entire conversation history —
// quadratic trace growth (a 213-step turn measured at 147 MB, 94.5% of it
// duplicated snapshots) that pushes export batches past downstream gRPC
// message limits (Tempo default 4 MiB) and silently drops whole traces.
// The contract: one snapshot anchor on the first request of a turn, deltas
// only afterwards, and a UTF-8 byte budget on the accumulator.

const SID = 'session-test-0001';

function record(type: string, data: Record<string, unknown>, time = 1000): Record<string, unknown> {
  return { sid: SID, time, type, data };
}

function run(records: Record<string, unknown>[]): AgentActivityEntry[] {
  const state = newState();
  const entries: AgentActivityEntry[] = [];
  for (const r of records) {
    entries.push(...transformDshRecordEntries(r, ClientType.Dsh, state));
  }
  return entries;
}

describe('dsh-event-transform: incremental input payloads', () => {
  function assistantMessage(turn: number, step: number, time: number): Record<string, unknown> {
    return record('assistant/message', {
      turn,
      step,
      stream: [{ type: 'chunk', time: time - 10, chunk: { type: 'text' } }],
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `step-${step}` }],
        source: { provider: 'test', model: 'test-model' },
      },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    }, time);
  }

  function userMessage(turn: number, text: string, time: number): Record<string, unknown> {
    return record('user/message', {
      turn,
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }, time);
  }

  it('sends the full input snapshot only on the first request of a turn', () => {
    const entries = run([
      record('turn/start', { turn: 1 }, 90),
      userMessage(1, 'hello', 100),
      assistantMessage(1, 1, 200),
      assistantMessage(1, 2, 300),
      assistantMessage(1, 3, 400),
    ]);
    const requests = entries.filter(e => e['event.name'] === 'llm.request')
      .sort((a, b) => String(a['gen_ai.step.id']).localeCompare(String(b['gen_ai.step.id'])));
    expect(requests.length).toBe(3);
    // First request anchors; later ones are delta-only.
    const anchor = requests[0]['gen_ai.input.messages'] as unknown[];
    expect(Array.isArray(anchor)).toBe(true);
    expect(requests[0]['gen_ai.input.messages_delta']).toEqual(anchor);
    expect(requests[1]['gen_ai.input.messages']).toBeUndefined();
    expect(requests[2]['gen_ai.input.messages']).toBeUndefined();
    expect((requests[1]['gen_ai.input.messages_delta'] as unknown[]).length).toBeGreaterThan(0);
    expect((requests[2]['gen_ai.input.messages_delta'] as unknown[]).length).toBeGreaterThan(0);
  });

  it('re-anchors the snapshot on the first request of the next turn', () => {
    const entries = run([
      record('turn/start', { turn: 1 }, 90),
      userMessage(1, 'hello', 100),
      assistantMessage(1, 1, 200),
      record('turn/end', { turn: 1, reason: { kind: 'completed' } }, 400),
      record('turn/start', { turn: 2 }, 490),
      userMessage(2, 'next turn', 500),
      assistantMessage(2, 1, 600),
      assistantMessage(2, 2, 700),
    ]);
    const requests = entries.filter(e => e['event.name'] === 'llm.request')
      .sort((a, b) => String(a['gen_ai.step.id']).localeCompare(String(b['gen_ai.step.id'])));
    expect(requests.length).toBe(3);
    expect(requests[0]['gen_ai.input.messages']).toBeDefined();
    expect(requests[1]['gen_ai.input.messages']).toBeDefined(); // turn 2 anchor
    expect(requests[2]['gen_ai.input.messages']).toBeUndefined();
    // Turn-2 anchor must not contain turn-1 messages.
    const turn2Anchor = requests[1]['gen_ai.input.messages'] as Array<{ role: string }>;
    expect(turn2Anchor.every(m => m.role === 'user')).toBe(true);
  });

  it('overflows the accumulator past the byte budget and omits payloads', () => {
    const big = 'x'.repeat(300 * 1024); // > 256 KiB budget in one message
    const entries = run([
      record('turn/start', { turn: 1 }, 90),
      userMessage(1, big, 100),
      assistantMessage(1, 1, 200),
    ]);
    const requests = entries.filter(e => e['event.name'] === 'llm.request');
    expect(requests.length).toBe(1);
    expect(requests[0]['gen_ai.input.messages']).toBeUndefined();
    expect(requests[0]['gen_ai.input.messages_delta']).toBeUndefined();
  });
});
