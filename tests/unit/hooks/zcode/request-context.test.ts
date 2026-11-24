import { describe, expect, it } from 'vitest';
import { prepareZCodeRequestContext } from '../../../../src/flushers/zcode-request-context.js';
import { stripAgentMessageContent } from '../../../../src/normalization/agent-content-policy.js';
import { buildAgentActivityEntry } from '../../../../src/normalization/entry-builder.js';
import { readZCodeMessageWindow, ZCODE_MESSAGE_WINDOW } from '../../../../src/normalization/zcode-message-window.js';

function request(index: number, kind: 'full' | 'delta', offset: number, texts: string[], turn = 'turn-a') {
  const messages = texts.map(content => ({ role: 'user', parts: [{ type: 'text', content }] }));
  const window = readZCodeMessageWindow({
    messagesKind: kind, messageOffset: offset, messageCount: offset + messages.length, messages,
  });
  return buildAgentActivityEntry({
    'event.name': 'llm.request',
    'event.id': `request-${index}`,
    'gen_ai.agent.type': 'zcode',
    'gen_ai.session.id': 'session-a',
    'gen_ai.turn.id': turn,
    time_unix_nano: String(index),
    trace_id: 'a'.repeat(32),
    'gen_ai.input.messages': messages,
    attributes: window ? { [ZCODE_MESSAGE_WINDOW]: window } : {},
  });
}

describe('ZCode native request context', () => {
  it('restores an empty retry and appends genuine deltas without changing input events', () => {
    const first = request(1, 'full', 0, ['first']);
    const retry = request(2, 'delta', 1, []);
    const next = request(3, 'delta', 1, ['continuation']);
    const converted = prepareZCodeRequestContext([first, retry, next]);
    expect(converted[1]['gen_ai.input.messages']).toEqual(first['gen_ai.input.messages']);
    expect(converted[2]['gen_ai.input.messages']).toEqual([
      ...(first['gen_ai.input.messages'] as unknown[]), ...(next['gen_ai.input.messages'] as unknown[]),
    ]);
    expect(retry['gen_ai.input.messages']).toEqual([]);
    expect(next['gen_ai.input.messages']).toHaveLength(1);
  });

  it('uses the newest full snapshot and leaves a delta from another turn unexpanded', () => {
    const first = request(1, 'full', 0, ['old prefix']);
    const reset = request(2, 'full', 0, ['replacement']);
    const foreign = request(3, 'delta', 1, [], 'turn-b');
    const retry = request(4, 'delta', 1, []);
    const converted = prepareZCodeRequestContext([first, reset, foreign, retry]);
    expect(converted[2]).toBe(foreign);
    expect(converted[3]['gen_ai.input.messages']).toEqual(reset['gen_ai.input.messages']);
  });

  it('waits for another full snapshot after a missing native window', () => {
    const first = request(1, 'full', 0, ['prefix']);
    const gap = request(2, 'delta', 2, ['unanchored']);
    const missing = request(3, 'delta', 1, []);
    expect(prepareZCodeRequestContext([first, gap, missing])).toEqual([first, gap, missing]);
    expect(prepareZCodeRequestContext([missing])[0]).toBe(missing);
  });

  it('never restores a captured prefix across a content opt-out', () => {
    const first = request(1, 'full', 0, ['previously captured']);
    const hidden = stripAgentMessageContent(request(2, 'delta', 1, []));
    const after = request(3, 'delta', 1, []);
    const converted = prepareZCodeRequestContext([first, hidden, after]);
    expect(converted[1]['gen_ai.input.messages']).toBeUndefined();
    expect(converted[2]['gen_ai.input.messages']).toEqual([]);
  });

  it('ignores incomplete, inconsistent, and clipped native slices', () => {
    expect(readZCodeMessageWindow({ messagesKind: 'full', messageOffset: 0, messageCount: 2,
      messages: [{ role: 'user' }] })).toBeUndefined();
    expect(readZCodeMessageWindow({ messagesKind: 'delta', messageOffset: 1, messageCount: 2,
      messages_sample_truncated: [{ role: 'user' }] })).toBeUndefined();
    expect(readZCodeMessageWindow({ messagesKind: 'full', messageOffset: 1, messageCount: 1,
      messages: [] })).toBeUndefined();
  });
});
