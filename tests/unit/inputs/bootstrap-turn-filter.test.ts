import { describe, expect, it } from 'vitest';
import { filterBootstrapHistoryTurns } from '../../../src/inputs/base/bootstrap-turn-filter.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';

function entry(
  id: string,
  turnId: string,
  mode: 'bootstrap' | 'incremental',
  batchId?: string,
): AgentActivityEntry {
  return {
    'event.id': id,
    'event.name': 'llm.response',
    'gen_ai.agent.type': 'qoder',
    'gen_ai.turn.id': turnId,
    'agent.transcript.cursor_mode': mode,
    ...(batchId ? { 'agent.transcript.cursor_batch_id': batchId } : {}),
  } as AgentActivityEntry;
}

describe('filterBootstrapHistoryTurns', () => {
  it('keeps only the latest turn in each bootstrap batch', () => {
    const entries = [
      entry('old-request', 'turn-old', 'bootstrap', 'batch-a'),
      entry('old-response', 'turn-old', 'bootstrap', 'batch-a'),
      entry('latest-request', 'turn-latest', 'bootstrap', 'batch-a'),
      entry('latest-response', 'turn-latest', 'bootstrap', 'batch-a'),
    ];

    expect(filterBootstrapHistoryTurns(entries).map(e => e['event.id'])).toEqual([
      'latest-request',
      'latest-response',
    ]);
  });

  it('scopes recovery independently per transcript invocation batch', () => {
    const entries = [
      entry('a-old', 'a-old-turn', 'bootstrap', 'batch-a'),
      entry('a-latest', 'a-latest-turn', 'bootstrap', 'batch-a'),
      entry('b-old', 'b-old-turn', 'bootstrap', 'batch-b'),
      entry('b-latest', 'b-latest-turn', 'bootstrap', 'batch-b'),
      entry('normal', 'normal-turn', 'incremental', 'batch-c'),
    ];

    expect(filterBootstrapHistoryTurns(entries).map(e => e['event.id'])).toEqual([
      'a-latest',
      'b-latest',
      'normal',
    ]);
  });

  it('fails open when a mixed-version record has no batch id', () => {
    const entries = [
      entry('legacy-old', 'legacy-old-turn', 'bootstrap'),
      entry('legacy-new', 'legacy-new-turn', 'bootstrap'),
    ];

    expect(filterBootstrapHistoryTurns(entries)).toEqual(entries);
  });
});
