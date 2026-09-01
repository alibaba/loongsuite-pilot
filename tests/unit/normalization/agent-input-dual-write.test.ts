import { describe, expect, it } from 'vitest';
import { v5 as uuidv5 } from 'uuid';
import {
  AGENT_INPUT_EVENT_NAMESPACE,
  deriveAgentInputEventId,
  expandAgentInputEvents,
  isInputOtherEvent,
} from '../../../src/normalization/agent-input-dual-write.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';

function makeEntry(overrides: Partial<AgentActivityEntry> = {}): AgentActivityEntry {
  return {
    time_unix_nano: '1700000000000000000',
    'event.id': 'source-event',
    'event.name': 'other',
    'user.id': 'user-1',
    'gen_ai.session.id': 'session-1',
    'gen_ai.agent.type': 'codex',
    'gen_ai.provider.name': 'openai',
    ...overrides,
  };
}

describe('agent input compatibility dual-write', () => {
  it('recognizes only other events with canonical input fields', () => {
    expect(isInputOtherEvent(makeEntry({ 'gen_ai.input.messages': [] }))).toBe(true);
    expect(isInputOtherEvent(makeEntry({ 'gen_ai.input.messages_delta': [] }))).toBe(true);
    expect(isInputOtherEvent(makeEntry())).toBe(false);
    expect(isInputOtherEvent(makeEntry({
      'event.name': 'llm.request',
      'gen_ai.input.messages': [],
    }))).toBe(false);
    expect(isInputOtherEvent(makeEntry({
      'event.name': 'agent.input',
      'gen_ai.input.messages': [],
    }))).toBe(false);
  });

  it.each([
    ['messages', { 'gen_ai.input.messages': [{ role: 'user', content: 'hello' }] }],
    ['messages_delta', { 'gen_ai.input.messages_delta': [{ role: 'user', content: 'hello' }] }],
    ['empty messages_delta', { 'gen_ai.input.messages_delta': [] }],
  ])('expands input other with %s', (_name, inputFields) => {
    const source = makeEntry(inputFields as Partial<AgentActivityEntry>);
    const result = expandAgentInputEvents([source]);

    expect(result).toHaveLength(2);
    expect(result[0]).toBe(source);
    expect(result[1]['event.name']).toBe('agent.input');
  });

  it('preserves content while omitting turn boundaries from the derived event', () => {
    const source = makeEntry({
      'gen_ai.input.messages_delta': [{ role: 'user', content: 'hello' }],
      trace_id: '0123456789abcdef0123456789abcdef',
      'gen_ai.turn.id': 'turn-1',
      'gen_ai.turn.start': true,
      'gen_ai.turn.end': true,
      custom: { nested: ['value'] },
    });

    const [, derived] = expandAgentInputEvents([source]);
    const stripDerivedFields = (entry: AgentActivityEntry) => {
      const comparable = { ...entry };
      delete comparable['event.id'];
      delete comparable['event.name'];
      delete comparable['gen_ai.turn.start'];
      delete comparable['gen_ai.turn.end'];
      return comparable;
    };

    expect(stripDerivedFields(derived)).toEqual(stripDerivedFields(source));
    expect(derived['event.id']).not.toBe(source['event.id']);
    expect(derived['gen_ai.turn.start']).toBeUndefined();
    expect(derived['gen_ai.turn.end']).toBeUndefined();
    expect(source['gen_ai.turn.start']).toBe(true);
    expect(source['gen_ai.turn.end']).toBe(true);
    expect(source['event.name']).toBe('other');
    expect(source['event.id']).toBe('source-event');
  });

  it('derives a deterministic UUID v5 in the fixed namespace', () => {
    const expected = uuidv5('source-event', AGENT_INPUT_EVENT_NAMESPACE);
    expect(deriveAgentInputEventId('source-event')).toBe(expected);
    expect(deriveAgentInputEventId('source-event')).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('preserves original order and inserts the derived event next to its source', () => {
    const before = makeEntry({ 'event.id': 'before', 'event.name': 'tool.call' });
    const source = makeEntry({
      'event.id': 'input',
      'gen_ai.input.messages_delta': [{ role: 'user', content: 'hello' }],
    });
    const after = makeEntry({ 'event.id': 'after', 'event.name': 'tool.result' });

    const result = expandAgentInputEvents([before, source, after]);
    expect(result.map(entry => entry['event.id'])).toEqual([
      'before',
      'input',
      deriveAgentInputEventId('input'),
      'after',
    ]);
  });

  it('is idempotent when an expanded batch is processed again', () => {
    const source = makeEntry({
      'gen_ai.input.messages_delta': [{ role: 'user', content: 'hello' }],
    });
    const once = expandAgentInputEvents([source]);
    const twice = expandAgentInputEvents(once);

    expect(twice.map(entry => entry['event.id'])).toEqual(
      once.map(entry => entry['event.id']),
    );
  });

  it('does not append when the derived ID already exists in the batch', () => {
    const source = makeEntry({
      'gen_ai.input.messages': [{ role: 'user', content: 'hello' }],
    });
    const existingDerived = makeEntry({
      'event.id': deriveAgentInputEventId(source['event.id']),
      'event.name': 'agent.input',
      'gen_ai.input.messages': source['gen_ai.input.messages'],
    });

    const result = expandAgentInputEvents([source, existingDerived]);
    expect(result).toEqual([source, existingDerived]);
  });

  it('preserves non-input other and all non-other events unchanged', () => {
    const metadataOther = makeEntry({ 'event.id': 'metadata' });
    const request = makeEntry({
      'event.id': 'request',
      'event.name': 'llm.request',
      'gen_ai.input.messages': [{ role: 'user', content: 'hello' }],
    });

    expect(expandAgentInputEvents([metadataOther, request])).toEqual([
      metadataOther,
      request,
    ]);
  });
});
