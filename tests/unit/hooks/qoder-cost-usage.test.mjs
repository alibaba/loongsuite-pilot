import { describe, expect, it } from 'vitest';
import { buildLlmBoundaries, buildEventsFromBoundaries } from '../../../assets/hooks/qoder-hook-processor.mjs';
import { buildCanonicalHookEntry } from '../../../src/inputs/base/canonical-hook-record.ts';
import { projectLogEntry, serialiseLogEntry } from '../../../src/normalization/entry-builder.ts';
import { applyHookContentPolicy } from '../../../assets/hooks/agent-event-normalizer.mjs';

const user = { type: 'user', timestamp: '2026-11-23T01:00:00Z',
  message: { role: 'user', content: 'synthetic prompt' } };
const assistant = (seconds, message) => ({ type: 'assistant',
  timestamp: `2026-11-23T01:00:0${seconds}Z`, message: { role: 'assistant', model: 'synthetic', ...message } });
const build = (rows, agentId) => buildEventsFromBoundaries(buildLlmBoundaries([], rows),
  rows, rows, 'synthetic-turn', 'synthetic-session', agentId, {}, undefined)
  .filter(record => record['event.name'] === 'llm.response');

describe.each(['qoder', 'qoder-cn'])('%s reported cost usage', agentId => {
  it('uses the final snapshot once per response and preserves positive non-billable Credits through projection', () => {
    const rows = [user,
      assistant(1, { id: 'response-1', content: [{ type: 'text', text: 'partial' }],
        usage: { credits: 0.01, billable: true, request_id: 'request-1' } }),
      assistant(2, { content: [{ type: 'text', text: 'final' }], stop_reason: 'end_turn',
        usage: { credits: 0.125, original_credits: 0.5, billable: false, request_id: 'request-1',
          input_tokens: 42, output_tokens: 7 } }),
      assistant(3, { id: 'response-2', content: [{ type: 'text', text: 'second' }], stop_reason: 'end_turn',
        usage: { credits: 0.25, billable: true, request_id: 'request-2' } }),
    ];
    const responses = build(rows, agentId);
    expect(responses).toHaveLength(2);
    expect(responses.map(record => record['gen_ai.usage.cost.amount'])).toEqual([0.125, 0.25]);
    expect(responses[0]['gen_ai.response.id']).toBe('response-1');
    expect(responses[0]['agent.client_request_id']).toBe('request-1');
    const entry = buildCanonicalHookEntry({ ...responses[0], 'agent.qoder.internal': 'synthetic' }, agentId);
    const projected = projectLogEntry(entry, { dropAgentScopedFields: true });
    expect(projected).toMatchObject({ 'gen_ai.usage.cost.amount': 0.125,
      'gen_ai.usage.cost.unit': agentId === 'qoder-cn' ? 'qodercn_credit' : 'qoder_credit', 'gen_ai.usage.cost.source': 'provider',
      'agent.qoder.usage.billable': false, 'gen_ai.usage.input_tokens': 42, 'gen_ai.usage.output_tokens': 7 });
    expect(projected['agent.qoder.internal']).toBeUndefined();
    expect(projected['gen_ai.usage.cost.currency']).toBeUndefined();
    expect(projected['gen_ai.usage.total_cost']).toBeUndefined();
    expect(projected['gen_ai.usage.credits.amount']).toBeUndefined();
    expect(serialiseLogEntry(entry, { dropAgentScopedFields: true })['agent.qoder.usage.billable']).toBe('false');
  });

  it('preserves explicit zero and supports a usage-only response without inventing token counts', () => {
    const [response] = build([user, assistant(1, { id: 'zero-response', content: [],
      stop_reason: 'end_turn', usage: { credits: 0, billable: false } })], agentId);
    expect(response['gen_ai.usage.cost.amount']).toBe(0);
    expect(response['agent.qoder.usage.billable']).toBe(false);
    expect(response['gen_ai.usage.input_tokens']).toBeUndefined();
    expect(response['gen_ai.usage.output_tokens']).toBeUndefined();
  });

  it.each([undefined, null, -1, '0.125', NaN, Infinity])('omits unknown or invalid amount %s and ignores session totals', amount => {
    const [response] = build([user, assistant(1, { id: 'invalid-response', content: [{ type: 'text', text: 'answer' }],
      stop_reason: 'end_turn', usage: { credits: amount, billable: false, original_credits: 0.5,
        total_credits: 99, modelUsage: { synthetic: { credits: 99 } } } })], agentId);
    expect(response['gen_ai.usage.cost.amount']).toBeUndefined();
    expect(response['gen_ai.usage.cost.unit']).toBeUndefined();
    expect(response['agent.qoder.usage.billable']).toBeUndefined();
  });

  it('does not infer unknown billing status', () => {
    const [response] = build([user, assistant(1, { id: 'unknown-billing', content: [{ type: 'text', text: 'answer' }],
      stop_reason: 'end_turn', usage: { credits: 0.125 } })], agentId);
    expect(response['gen_ai.usage.cost.amount']).toBe(0.125);
    expect(response['agent.qoder.usage.billable']).toBeUndefined();
  });

  it('retains usage with message capture disabled', () => {
    const rows = [user, assistant(1, { id: 'private-response', content: [{ type: 'text', text: 'private text' }],
      stop_reason: 'end_turn', usage: { credits: 0.125, billable: false } })];
    const [rawResponse] = buildEventsFromBoundaries(buildLlmBoundaries([], rows), rows, rows,
      'synthetic-turn', 'synthetic-session', agentId, {}, undefined)
      .filter(record => record['event.name'] === 'llm.response');
    const response = applyHookContentPolicy(rawResponse, { agents: { [agentId]: { captureMessageContent: false } } });
    expect(response['gen_ai.usage.cost.amount']).toBe(0.125);
    expect(response['agent.qoder.usage.billable']).toBe(false);
    expect(JSON.stringify(response)).not.toContain('private text');
  });
});
