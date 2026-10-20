import { describe, expect, it } from 'vitest';
import { buildCopilotEvents, collectSessionCost } from '../../../../src/inputs/copilot/copilot-event-builder.js';
import { projectLogEntry } from '../../../../src/normalization/entry-builder.js';
import { checkpointEvent, ev, resetFixtureIds, shutdownEvent, T0, textOnlyTurn } from '../../../fixtures/copilot/events.js';

const opts = { sessionId: 's-1' };
const costEntries = (events: ReturnType<typeof textOnlyTurn>, o: Parameters<typeof buildCopilotEvents>[1] = opts) =>
  buildCopilotEvents(events, o).filter(e => e['agent.copilot.usage.source'] !== undefined);

describe('session cost from usage checkpoints', () => {
  it('emits the cumulative session cost and premium requests at an interaction checkpoint', () => {
    const [entry] = costEntries([...textOnlyTurn(), checkpointEvent(T0 + 3_000, 100, 1)]);
    expect(entry['event.name']).toBe('other');
    expect(entry['agent.copilot.usage.source']).toBe('checkpoint');
    expect(entry['agent.copilot.usage.scope']).toBe('session');
    expect(entry['agent.copilot.usage.nano_aiu']).toBe(100);
    expect(entry['agent.copilot.usage.premium_requests']).toBe(1);
    expect(entry['agent.copilot.usage.turn_id']).toBe('i-1');
    expect(entry['gen_ai.turn.id']).toBeUndefined();
    expect(entry['gen_ai.step.id']).toBeUndefined();
    expect(entry['gen_ai.session.id']).toBe('s-1');
  });

  it('works without any shutdown, so a session that never closes still reports cost', () => {
    const entries = buildCopilotEvents([...textOnlyTurn(), checkpointEvent(T0 + 3_000, 100, 1)], opts);
    expect(entries.some(e => e['agent.copilot.usage.source'] === 'checkpoint')).toBe(true);
    expect(entries.some(e => e['gen_ai.usage.input_tokens'] !== undefined)).toBe(false);
  });

  it('reports only the increment between checkpoints', () => {
    const events = [...textOnlyTurn(), checkpointEvent(T0 + 3_000, 100, 1), checkpointEvent(T0 + 9_000, 260, 2)];
    const [first, second] = costEntries(events);
    expect([first['agent.copilot.usage.nano_aiu'], first['agent.copilot.usage.premium_requests']]).toEqual([100, 1]);
    expect([second['agent.copilot.usage.nano_aiu'], second['agent.copilot.usage.premium_requests']]).toEqual([160, 1]);
    expect(first['event.id']).not.toBe(second['event.id']);
  });

  it('emits nothing when a checkpoint repeats the totals already reported', () => {
    const events = [...textOnlyTurn(), checkpointEvent(T0 + 3_000, 100, 1), checkpointEvent(T0 + 9_000, 100, 1)];
    expect(costEntries(events)).toHaveLength(1);
  });

  it('never emits placeholders for totals the checkpoint does not carry', () => {
    const [onlyPremium] = costEntries([checkpointEvent(T0, undefined, 3)]);
    expect(onlyPremium['agent.copilot.usage.premium_requests']).toBe(3);
    expect(onlyPremium['agent.copilot.usage.nano_aiu']).toBeUndefined();
    resetFixtureIds();
    expect(costEntries([checkpointEvent(T0)])).toEqual([]);
  });

  it('treats totals already reported as prior and reports the full value after a reset', () => {
    expect(costEntries([checkpointEvent(T0, 100, 1)], { ...opts, priorCost: { nanoAiu: 100, premiumRequests: 1 } })).toEqual([]);
    const [reset] = costEntries([checkpointEvent(T0, 100, 1)], { ...opts, priorCost: { nanoAiu: 500, premiumRequests: 4 } });
    expect(reset['agent.copilot.usage.nano_aiu']).toBe(100);
    expect(reset['agent.copilot.usage.premium_requests']).toBe(1);
  });
});

describe('session cost at shutdown', () => {
  const models = { 'model-a': { inputTokens: 10, outputTokens: 1, totalNanoAiu: 160 } };

  it('adds only the cost not yet reported by checkpoints', () => {
    const events = [...textOnlyTurn(), checkpointEvent(T0 + 3_000, 100, 1), shutdownEvent(T0 + 9_000, models, { nanoAiu: 160, premiumRequests: 2 })];
    const entries = costEntries(events);
    expect(entries.map(e => e['agent.copilot.usage.source'])).toEqual(['checkpoint', 'shutdown']);
    expect(entries[1]['agent.copilot.usage.nano_aiu']).toBe(60);
    expect(entries[1]['agent.copilot.usage.premium_requests']).toBe(1);
  });

  it('adds no cost entry when the checkpoints already covered the session total', () => {
    const events = [...textOnlyTurn(), checkpointEvent(T0 + 3_000, 160, 2), shutdownEvent(T0 + 9_000, models, { nanoAiu: 160, premiumRequests: 2 })];
    expect(costEntries(events).map(e => e['agent.copilot.usage.source'])).toEqual(['checkpoint']);
  });

  it('reports the whole session cost at shutdown when there was no checkpoint', () => {
    const [entry] = costEntries([...textOnlyTurn(), shutdownEvent(T0 + 9_000, models, { nanoAiu: 160, premiumRequests: 2 })]);
    expect(entry['agent.copilot.usage.source']).toBe('shutdown');
    expect(entry['agent.copilot.usage.nano_aiu']).toBe(160);
  });

  it('keeps the per-model cost as a breakdown that is not the additive cost field', () => {
    const events = [...textOnlyTurn(), shutdownEvent(T0 + 9_000, models, { nanoAiu: 160, premiumRequests: 2 })];
    const summary = buildCopilotEvents(events, opts).find(e => e['gen_ai.usage.input_tokens'] !== undefined)!;
    expect(summary['agent.copilot.usage.model_nano_aiu']).toBe(160);
    expect(summary['agent.copilot.usage.nano_aiu']).toBeUndefined();
    expect(summary['agent.copilot.usage.source']).toBeUndefined();
  });
});

describe('collectSessionCost', () => {
  it('returns the latest cumulative session cost across checkpoints and shutdowns', () => {
    resetFixtureIds();
    const events = [checkpointEvent(T0, 100, 1), shutdownEvent(T0 + 1, {}, { nanoAiu: 160, premiumRequests: 2 }), ev('user.message', { content: 'x' }, T0 + 2)];
    expect(collectSessionCost(events)).toEqual({ nanoAiu: 160, premiumRequests: 2 });
    expect(collectSessionCost([], { nanoAiu: 5 })).toEqual({ nanoAiu: 5 });
  });
});

describe('what reaches the log outputs', () => {
  it('keeps cost and premium requests after the JSONL/SLS projection instead of an empty other entry', () => {
    const events = [...textOnlyTurn(), checkpointEvent(T0 + 3_000, 100, 1),
      shutdownEvent(T0 + 9_000, { 'model-a': { inputTokens: 10, outputTokens: 1, reasoningTokens: 3, totalNanoAiu: 100 } }, { nanoAiu: 100, premiumRequests: 1 })];
    const projected = buildCopilotEvents(events, opts)
      .filter(e => e['event.name'] === 'other')
      .map(e => projectLogEntry(e, { dropAgentScopedFields: true }));
    const cost = projected.find(e => e['agent.copilot.usage.source'] === 'checkpoint')!;
    expect(cost['agent.copilot.usage.nano_aiu']).toBe(100);
    expect(cost['agent.copilot.usage.premium_requests']).toBe(1);
    const tokens = projected.find(e => e['gen_ai.usage.input_tokens'] !== undefined)!;
    expect(tokens['gen_ai.usage.output_tokens']).toBe(1);
    expect(tokens['agent.copilot.usage.reasoning_tokens']).toBe(3);
    expect(tokens['agent.copilot.usage.model_nano_aiu']).toBe(100);
  });
});
