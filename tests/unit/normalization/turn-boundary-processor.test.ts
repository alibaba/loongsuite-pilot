import { describe, expect, it } from 'vitest';
import {
  TurnBoundaryProcessor,
  isTerminalTurnEntry,
} from '../../../src/normalization/turn-boundary-processor.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { buildTestEntry } from '../../helpers/fixture-builder.js';

function entry(
  eventId: string,
  eventName: AgentActivityEntry['event.name'],
  extra: Partial<AgentActivityEntry> = {},
): AgentActivityEntry {
  return buildTestEntry({
    'event.id': eventId,
    'event.name': eventName,
    'gen_ai.turn.id': 'turn-1',
    ...extra,
  });
}

function withoutBoundaries(value: AgentActivityEntry): AgentActivityEntry {
  const copy = structuredClone(value);
  delete copy['gen_ai.turn.start'];
  delete copy['gen_ai.turn.end'];
  return copy;
}

describe('TurnBoundaryProcessor', () => {
  it('waits for the incremental Hermes end marker across separate response batches', () => {
    const processor = new TurnBoundaryProcessor();
    const base = { 'gen_ai.agent.type': 'hermes', 'agent.hermes.collection': 'realtime-v1' };
    const request = entry('request', 'llm.request', base);
    const error = entry('retry', 'llm.response', { ...base, 'gen_ai.response.finish_reasons': ['error'] });
    const stop = entry('stop', 'llm.response', { ...base, 'gen_ai.response.finish_reasons': ['stop'] });
    const terminal = entry('end', 'other', { ...base, 'gen_ai.turn.end': true });
    for (const value of [request, error, stop, terminal]) processor.enrich([value]);
    expect(request['gen_ai.turn.start']).toBe(true);
    expect(error['gen_ai.turn.end']).toBeUndefined();
    expect(stop['gen_ai.turn.end']).toBeUndefined();
    expect(terminal['gen_ai.turn.end']).toBe(true);
    expect([request, error, stop, terminal].filter(value => value['gen_ai.turn.end'])).toHaveLength(1);
  });

  it.each([
    'qoder',
    'qoder-cn',
    'qoder-idea',
    'qoder-cli',
    'qoder-work',
    'qoder-work-cn',
    'qwen-work-cn',
    'cursor',
    'cursor-cli',
    'claude-code',
    'kiro-cli',
    'opencode',
    'pi-coding-agent',
    'mimo-code',
    'qwen-code-cli',
    'hermes',
    'wukong',
    'workbuddy',
  ])('fills the default lifecycle for registered Agent type %s', agentType => {
    const entries = [
      entry(`${agentType}-request`, 'llm.request', {
        'gen_ai.agent.type': agentType,
      }),
      entry(`${agentType}-response`, 'llm.response', {
        'gen_ai.agent.type': agentType,
        'gen_ai.response.finish_reasons': ['stop'],
      }),
    ];

    new TurnBoundaryProcessor().enrich(entries);

    expect(entries[0]['gen_ai.turn.start']).toBe(true);
    expect(entries[1]['gen_ai.turn.end']).toBe(true);
  });

  it('adds one start and one end without changing any existing event data', () => {
    const entries = [
      entry('prompt', 'other'),
      entry('request', 'llm.request', { 'gen_ai.step.id': 'turn-1:s1' }),
      entry('response', 'llm.response', {
        'gen_ai.step.id': 'turn-1:s1',
        'gen_ai.response.finish_reasons': ['stop'],
      }),
    ];
    const before = structuredClone(entries);

    new TurnBoundaryProcessor().enrich(entries);

    expect(entries[0]['gen_ai.turn.start']).toBe(true);
    expect(entries[2]['gen_ai.turn.end']).toBe(true);
    expect(entries.filter(item => item['gen_ai.turn.start'] === true)).toHaveLength(1);
    expect(entries.filter(item => item['gen_ai.turn.end'] === true)).toHaveLength(1);
    expect(entries.map(withoutBoundaries)).toEqual(before.map(withoutBoundaries));
  });

  it('keeps producer-owned boundary placement exactly unchanged', () => {
    const entries = [
      entry('prompt', 'other'),
      entry('request', 'llm.request', { 'gen_ai.turn.start': true }),
      entry('response', 'llm.response', {
        'gen_ai.response.finish_reasons': ['stop'],
        'gen_ai.turn.end': true,
      }),
    ];
    const before = structuredClone(entries);

    new TurnBoundaryProcessor().enrich(entries);

    expect(entries).toEqual(before);
  });

  it('never overwrites producer-owned boundary fields', () => {
    const entries = [entry('producer-entry', 'other', {
      'gen_ai.turn.start': false,
      'gen_ai.turn.end': false,
    })];
    const before = structuredClone(entries);

    new TurnBoundaryProcessor().enrich(entries);

    expect(entries).toEqual(before);
  });

  it('tracks one turn across batches and marks only its real terminal batch', () => {
    const processor = new TurnBoundaryProcessor();
    const first = [entry('request', 'llm.request')];
    const middle = [entry('tool', 'tool.result')];
    const last = [entry('response', 'llm.response', {
      'gen_ai.response.finish_reasons': ['end_turn'],
    })];

    processor.enrich(first);
    processor.enrich(middle);
    processor.enrich(last);

    expect(first[0]['gen_ai.turn.start']).toBe(true);
    expect(middle[0]['gen_ai.turn.start']).toBeUndefined();
    expect(middle[0]['gen_ai.turn.end']).toBeUndefined();
    expect(last[0]['gen_ai.turn.start']).toBeUndefined();
    expect(last[0]['gen_ai.turn.end']).toBe(true);
  });

  it('marks every turn independently when one batch contains multiple turns', () => {
    const entries = [
      entry('turn-1-request', 'llm.request'),
      entry('turn-1-response', 'llm.response', {
        'gen_ai.response.finish_reasons': ['stop'],
      }),
      entry('turn-2-request', 'llm.request', { 'gen_ai.turn.id': 'turn-2' }),
      entry('turn-2-response', 'llm.response', {
        'gen_ai.turn.id': 'turn-2',
        'gen_ai.response.finish_reasons': ['end_turn'],
      }),
    ];

    new TurnBoundaryProcessor().enrich(entries);

    expect(entries.filter(item => item['gen_ai.turn.start'] === true).map(item => item['event.id']))
      .toEqual(['turn-1-request', 'turn-2-request']);
    expect(entries.filter(item => item['gen_ai.turn.end'] === true).map(item => item['event.id']))
      .toEqual(['turn-1-response', 'turn-2-response']);
  });

  it('accepts a repeated start after a fresh process-local processor is created', () => {
    const first = [entry('request', 'llm.request')];
    new TurnBoundaryProcessor().enrich(first);

    const last = [entry('response', 'llm.response', {
      'gen_ai.response.finish_reasons': ['stop'],
    })];
    new TurnBoundaryProcessor().enrich(last);

    expect(first[0]['gen_ai.turn.start']).toBe(true);
    expect(last[0]['gen_ai.turn.start']).toBe(true);
    expect(last[0]['gen_ai.turn.end']).toBe(true);
  });

  it('bounds process-local tracking by evicting the oldest observed turn', () => {
    const processor = new TurnBoundaryProcessor();
    const initial = Array.from({ length: 4_097 }, (_, index) => entry(
      `request-${index}`,
      'llm.request',
      { 'gen_ai.turn.id': `turn-${index}` },
    ));

    processor.enrich(initial);

    const evicted = [entry('request-evicted', 'llm.request', {
      'gen_ai.turn.id': 'turn-0',
    })];
    const retained = [entry('request-retained', 'llm.request', {
      'gen_ai.turn.id': 'turn-4096',
    })];
    processor.enrich(evicted);
    processor.enrich(retained);

    expect(evicted[0]['gen_ai.turn.start']).toBe(true);
    expect(retained[0]['gen_ai.turn.start']).toBeUndefined();
  });

  it('uses llm_output rather than per-call stop as the OpenClaw end', () => {
    const entries = [
      entry('response', 'llm.response', {
        'gen_ai.agent.type': 'openclaw',
        'gen_ai.response.finish_reasons': ['stop'],
      }),
      entry('terminal', 'other', {
        'gen_ai.agent.type': 'openclaw',
        'agent.openclaw.hook': 'llm_output',
      }),
    ];

    new TurnBoundaryProcessor().enrich(entries);

    expect(entries[0]['gen_ai.turn.start']).toBe(true);
    expect(entries[0]['gen_ai.turn.end']).toBeUndefined();
    expect(entries[1]['gen_ai.turn.end']).toBe(true);
  });

  it('uses only the explicit native Codex marker as the end', () => {
    const processor = new TurnBoundaryProcessor();
    const response = [entry('response', 'llm.response', {
      'gen_ai.agent.type': 'codex',
      'gen_ai.response.finish_reasons': ['stop'],
    })];
    const terminal = [entry('terminal', 'other', {
      'gen_ai.agent.type': 'codex',
      'agent.codex.turn_status': 'completed',
      'gen_ai.turn.end': true,
    })];

    processor.enrich(response);
    processor.enrich(terminal);

    expect(response[0]['gen_ai.turn.start']).toBeUndefined();
    expect(response[0]['gen_ai.turn.end']).toBeUndefined();
    expect(terminal[0]['gen_ai.turn.start']).toBeUndefined();
    expect(terminal[0]['gen_ai.turn.end']).toBe(true);
  });

  it.each(['completed', 'interrupted'])('does not infer a Codex end from %s status', status => {
    const entries = [entry('status-only', 'llm.response', {
      'gen_ai.agent.type': 'codex',
      'gen_ai.agent.scope': 'subagent',
      'agent.codex.turn_status': status,
      'gen_ai.response.finish_reasons': ['stop'],
    })];
    new TurnBoundaryProcessor().enrich(entries);
    expect(entries[0]['gen_ai.turn.end']).toBeUndefined();
    expect(isTerminalTurnEntry(entries[0])).toBe(false);
  });

  it('maintains independent Codex child turn boundaries after the parent ends', () => {
    const processor = new TurnBoundaryProcessor();
    const child = [entry('child-response', 'llm.response', {
      'gen_ai.agent.type': 'codex',
      'gen_ai.session.id': 'child-session',
      'gen_ai.turn.id': 'child-session:turn',
      'gen_ai.agent.scope': 'subagent',
      'gen_ai.response.finish_reasons': ['stop'],
    })];
    const root = [entry('root-terminal', 'other', {
      'gen_ai.agent.type': 'codex',
      'agent.codex.turn_status': 'completed',
      'gen_ai.turn.end': true,
    })];

    processor.enrich(child);
    processor.enrich(root);

    expect(child[0]['gen_ai.turn.start']).toBeUndefined();
    expect(child[0]['gen_ai.turn.end']).toBeUndefined();
    expect(root[0]['gen_ai.turn.start']).toBeUndefined();
    expect(root[0]['gen_ai.turn.end']).toBe(true);
    const terminal = entry('child-terminal', 'other', {
      'gen_ai.agent.type': 'codex', 'gen_ai.agent.scope': 'subagent',
      'gen_ai.session.id': 'child-session', 'gen_ai.turn.id': 'child-session:turn',
      'agent.codex.turn_status': 'completed',
      'gen_ai.turn.end': true,
    });
    processor.enrich([terminal]);
    expect(terminal['gen_ai.turn.start']).toBeUndefined();
    expect(terminal['gen_ai.turn.end']).toBe(true);
  });

  it('keeps the native Codex start while a fresh process sees only its suffix', () => {
    const first = entry('native-prompt', 'other', {
      'gen_ai.agent.type': 'codex',
      'gen_ai.turn.start': true,
    });
    new TurnBoundaryProcessor().enrich([first]);
    const suffix = entry('restored-request', 'llm.request', {
      'gen_ai.agent.type': 'codex',
    });
    const terminal = entry('native-terminal', 'other', {
      'gen_ai.agent.type': 'codex',
      'agent.codex.turn_status': 'completed',
      'gen_ai.turn.end': true,
    });
    new TurnBoundaryProcessor().enrich([suffix, terminal]);

    expect(first['gen_ai.turn.start']).toBe(true);
    expect(suffix['gen_ai.turn.start']).toBeUndefined();
    expect(terminal['gen_ai.turn.start']).toBeUndefined();
    expect(terminal['gen_ai.turn.end']).toBe(true);
  });

  it('does not repeat end for duplicate terminal signals', () => {
    const processor = new TurnBoundaryProcessor();
    const first = [entry('terminal-1', 'llm.response', {
      'gen_ai.response.finish_reasons': ['error'],
    })];
    const duplicate = [entry('terminal-2', 'llm.response', {
      'gen_ai.response.finish_reasons': ['error'],
    })];

    processor.enrich(first);
    processor.enrich(duplicate);

    expect(first[0]['gen_ai.turn.start']).toBe(true);
    expect(first[0]['gen_ai.turn.end']).toBe(true);
    expect(duplicate[0]['gen_ai.turn.start']).toBeUndefined();
    expect(duplicate[0]['gen_ai.turn.end']).toBeUndefined();
  });

  it('tracks equal turn IDs independently across sessions', () => {
    const entries = [
      entry('a', 'llm.request', { 'gen_ai.session.id': 'session-a' }),
      entry('b', 'llm.request', { 'gen_ai.session.id': 'session-b' }),
    ];

    new TurnBoundaryProcessor().enrich(entries);

    expect(entries[0]['gen_ai.turn.start']).toBe(true);
    expect(entries[1]['gen_ai.turn.start']).toBe(true);
  });

  it('leaves supplemental telemetry without a canonical turn ID untouched', () => {
    const supplemental = buildTestEntry({
      'event.id': 'tokens-only',
      'event.name': 'llm.response',
      'gen_ai.response.finish_reasons': ['stop'],
    });
    const before = structuredClone(supplemental);

    new TurnBoundaryProcessor().enrich([supplemental]);

    expect(supplemental).toEqual(before);
  });
});

describe('isTerminalTurnEntry', () => {
  it('recognizes the existing general, Codex, and OpenClaw terminal semantics', () => {
    expect(isTerminalTurnEntry(entry('general', 'llm.response', {
      'gen_ai.response.finish_reasons': ['cancelled'],
    }))).toBe(true);
    expect(isTerminalTurnEntry(entry('codex', 'other', {
      'gen_ai.agent.type': 'codex',
      'agent.codex.turn_status': 'interrupted',
    }))).toBe(false);
    expect(isTerminalTurnEntry(entry('codex-native-terminal', 'other', {
      'gen_ai.agent.type': 'codex',
      'gen_ai.turn.end': true,
    }))).toBe(true);
    expect(isTerminalTurnEntry(entry('openclaw', 'other', {
      'gen_ai.agent.type': 'openclaw',
      'agent.openclaw.hook': 'llm_output',
    }))).toBe(true);
  });
});
