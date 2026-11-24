import { describe, expect, it } from 'vitest';
import { StateStore } from '../../../../src/checkpoints/state-store.js';
import { ZcodeLogInput } from '../../../../src/inputs/zcode-log/zcode-log-input.js';

describe('ZcodeLogInput Stop records', () => {
  it.each([
    ['interrupted', 'cancelled'],
    ['cancelled', 'cancelled'],
    ['end_turn', 'end_turn'],
  ])('collects %s as %s', async (reason, expected) => {
    const input = new ZcodeLogInput({ stateStore: new StateStore('unused-zcode-state.json') });
    const result = await input['transformRecord']({
      'event.id': 'stop-1',
      'event.name': 'other',
      'gen_ai.agent.event.name': 'stop',
      'gen_ai.session.id': 'session-1',
      'gen_ai.turn.id': 'turn-1',
      'gen_ai.response.finish_reasons': [reason],
    });
    expect(result?.['gen_ai.response.finish_reasons']).toEqual([expected]);
  });
});
