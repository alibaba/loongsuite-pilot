import { describe, expect, it } from 'vitest';
import { checkpointDraft } from '../../../src/inputs/doubao-work/doubao-work-state.js';

describe('Doubao private checkpoint draft', () => {
  it('does not clone or dirty an unchanged poll', () => {
    const base = { pending: { turn: { query: 1, actors: ['one'] } }, complete: { one: 2 } };
    const draft = checkpointDraft(base);
    expect(Object.entries(draft.value.pending).map(([id, value]) => [id, value.query])).toEqual([['turn', 1]]);
    draft.value.pending.turn.query = 1;
    delete (draft.value.pending as any).absent;
    expect(draft.finish()).toBe(base);
  });

  it('keeps the committed state intact through nested array and record edits', () => {
    const base = { pending: { turn: { query: 1, actors: ['one'] } }, complete: { one: 2 } };
    const draft = checkpointDraft(base);
    draft.value.pending.turn.actors.push('two');
    draft.value.pending.turn.query++;
    const next = draft.finish();
    expect(base.pending.turn).toEqual({ query: 1, actors: ['one'] });
    expect(next.pending.turn).toEqual({ query: 2, actors: ['one', 'two'] });
    expect(next.complete).toBe(base.complete);
    expect(JSON.parse(JSON.stringify(next))).toEqual(next);
  });

  it('resolves borrowed references when a pending turn moves to roots', () => {
    const base: any = { pending: { one: { terminal: { time: '123' } } }, roots: {} };
    const draft = checkpointDraft(base);
    const pending = draft.value.pending.one;
    draft.value.roots.one = { ...pending, status: 'complete' };
    delete draft.value.pending.one;
    const next = draft.finish();
    expect(next.roots.one).toEqual({ terminal: { time: '123' }, status: 'complete' });
    expect(next.roots.one.terminal).toBe(base.pending.one.terminal);
    expect(base.pending.one).toBeDefined();
  });
});
