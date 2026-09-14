import { describe, expect, it } from 'vitest';
import {
  buildLlmBoundaries,
  buildEventsFromBoundaries,
} from '../../../assets/hooks/qoder-hook-processor.mjs';
import { projectLogEntry } from '../../../src/normalization/entry-builder.ts';

// gen_ai.response.id carries the provider's response id, whose spelling changes
// per provider (32-hex, uuid, chatcmpl-*, resp_*) and only coincidentally equals
// a segment's request_id. message.usage.request_id is the CLI's own id and is
// the same value a segment records, so the hook lifts it onto
// agent.client_request_id for the token-enricher to join on.
function userRow(text) {
  return {
    type: 'user',
    timestamp: '2026-08-03T09:22:25.100000Z',
    message: { role: 'user', content: text },
  };
}

/** Streaming writes msg.id on the opening row and usage on the closing one. */
function assistantRow(timestamp, message) {
  return { type: 'assistant', timestamp, message: { role: 'assistant', ...message } };
}

function buildFrom(rows, progress = []) {
  const boundaries = buildLlmBoundaries(progress, rows);
  return buildEventsFromBoundaries(
    boundaries, rows, rows, 'turn-1', 'session-1', 'qoder', {}, undefined,
  );
}

function responses(records) {
  return records.filter(record => record['event.name'] === 'llm.response');
}

describe('qoder hook agent.client_request_id', () => {
  it('lifts usage.request_id off the row that closes the response', () => {
    const records = buildFrom([
      userRow('explain spans'),
      assistantRow('2026-08-03T09:22:26.000000Z', {
        id: 'resp_074f8158b56ee638016a968589ddb48193',
        model: 'qwen-max',
        content: [{ type: 'text', content: 'partial' , text: 'partial' }],
      }),
      assistantRow('2026-08-03T09:22:27.000000Z', {
        model: 'qwen-max',
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 29194,
          output_tokens: 43,
          request_id: 'f2a2d7da-9bd0-4dd8-b144-195adc8ffc32',
        },
      }),
    ]);

    const [response] = responses(records);
    expect(response['agent.client_request_id']).toBe('f2a2d7da-9bd0-4dd8-b144-195adc8ffc32');
    // The provider id is still reported separately; the two are not interchangeable.
    expect(response['gen_ai.response.id']).toBe('resp_074f8158b56ee638016a968589ddb48193');
  });

  it('reads the id when it shares a row with message.id', () => {
    const records = buildFrom([
      userRow('explain spans'),
      assistantRow('2026-08-03T09:22:26.000000Z', {
        id: '06e5b7b833c1b4c47d515d39c2acff8c',
        model: 'qwen-max',
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
        usage: { request_id: 'c034d35f-d7d1-41a8-9a14-d9681a0e2505' },
      }),
    ]);

    expect(responses(records)[0]['agent.client_request_id'])
      .toBe('c034d35f-d7d1-41a8-9a14-d9681a0e2505');
  });

  it('leaves the field absent when the transcript has no usage', () => {
    const records = buildFrom([
      userRow('explain spans'),
      assistantRow('2026-08-03T09:22:26.000000Z', {
        id: 'message-1',
        model: 'qwen-max',
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
      }),
    ]);

    expect(responses(records)[0]['agent.client_request_id']).toBeUndefined();
  });

  it('ignores a usage object without a usable request_id', () => {
    for (const usage of [
      { input_tokens: 10, output_tokens: 2 },
      { request_id: '' },
      { request_id: 42 },
    ]) {
      const records = buildFrom([
        userRow('explain spans'),
        assistantRow('2026-08-03T09:22:26.000000Z', {
          id: 'message-1',
          model: 'qwen-max',
          content: [{ type: 'text', text: 'done' }],
          stop_reason: 'end_turn',
          usage,
        }),
      ]);
      expect(responses(records)[0]['agent.client_request_id']).toBeUndefined();
    }
  });

  it('gives each step of a turn its own client request id', () => {
    const rows = [
      userRow('run a tool then answer'),
      assistantRow('2026-08-03T09:22:25.555446Z', {
        id: 'resp_step_one',
        model: 'qwen-max',
        content: [{ type: 'tool_use', id: 'tool-b', name: 'Read', input: {} }],
        stop_reason: 'tool_use',
        usage: { request_id: 'cli-req-step-1' },
      }),
      {
        type: 'user',
        timestamp: '2026-08-03T09:22:26.668419Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-b', content: 'ok' }],
        },
      },
      assistantRow('2026-08-03T09:22:26.999890Z', {
        id: 'resp_step_two',
        model: 'qwen-max',
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
        usage: { request_id: 'cli-req-step-2' },
      }),
    ];
    const progress = [
      { hookEvent: 'UserPromptSubmit', ts: '2026-08-03T09:22:25.000000Z' },
      { hookEvent: 'PreToolUse', ts: '2026-08-03T09:22:25.996439Z' },
      { hookEvent: 'PostToolUse', ts: '2026-08-03T09:22:26.999176Z' },
      { hookEvent: 'Stop', ts: '2026-08-03T09:22:28.000000Z' },
    ];

    const found = responses(buildFrom(rows, progress))
      .map(record => record['agent.client_request_id']);
    expect(found).toEqual(['cli-req-step-1', 'cli-req-step-2']);
  });

  // AGENT_SCOPED_FIELD_RE in entry-builder.ts is /^agent\.[^.]+\..+$/ and both
  // sls-flusher and jsonl-flusher serialise with dropAgentScopedFields: true, so
  // an `agent.qoder.client_request_id` spelling would reach neither sink. Driven
  // through the real serialiser rather than a copied regex, because a copied
  // predicate is exactly what stops catching the divergence it guards.
  it('spells the field so it survives flusher serialisation', () => {
    const records = buildFrom([
      userRow('explain spans'),
      assistantRow('2026-08-03T09:22:26.000000Z', {
        id: 'message-1',
        model: 'qwen-max',
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
        usage: { request_id: 'cli-req-A' },
      }),
    ]);
    const response = responses(records)[0];
    // Guards the assertion below: a sibling agent-scoped field has to be present
    // on this very record for its absence after projection to mean anything.
    expect(response['agent.qoder.match_ts']).toBeTypeOf('number');

    const projected = projectLogEntry(response, { dropAgentScopedFields: true });
    expect(projected['agent.client_request_id']).toBe('cli-req-A');
    expect(projected['agent.qoder.match_ts']).toBeUndefined();
  });
});
